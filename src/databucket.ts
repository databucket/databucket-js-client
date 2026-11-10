import { Bucket } from './bucket.js';
import { DatabucketError, type Project } from './model.js';

export const API_VERSION_HEADER = 'Databucket-Api-Version';
const API_VERSION = '2';
const USER_AGENT = 'databucket-js-client/2';

export interface DatabucketOptions {
  /** The address of Databucket, e.g. `https://databucket.example.com` or `http://localhost:8080`. */
  url: string;
  /** Sign in with a username and password (POST /api/public/signin); together with {@link password}. */
  username?: string;
  password?: string;
  /**
   * Sign in with an access token of the identity provider (OAuth2 client credentials of a ROBOT account),
   * exchanged for a Databucket token (POST /api/public/sso/token-exchange). Called on every sign-in, so it can
   * fetch a fresh token.
   */
  ssoToken?: () => string | Promise<string>;
  /** A Databucket token you already have (no sign-in; it is not renewed). */
  token?: string;
  /** The project by id or by name (needed only when the user has several projects). */
  project?: number | string;
  /** Timeout of each request in milliseconds (default 30 000). */
  timeout?: number;
  /** Your own fetch, e.g. with a proxy (undici `ProxyAgent`) or for tests. */
  fetch?: typeof fetch;
  /** Called with a line per request, e.g. `console.debug`. */
  logger?: (message: string) => void;
}

type SignIn = (projectId: number | undefined) => Promise<any>;

/**
 * Client for one Databucket project, signed in as one user (typically a ROBOT account).
 * ```ts
 * const databucket = new Databucket({
 *   url: 'https://databucket.example.com',
 *   username: 'tests-robot',
 *   password: process.env.DATABUCKET_PASSWORD,
 *   project: 'Acme Shop',
 * });
 * const users = databucket.bucket<User>('dev-users');
 * const user = await users.reserve(Rules.where(Rule.property('$.status').eq('active'))).one();
 * ```
 * The client signs in on the first call and again when the token expires. One client can be shared by
 * parallel calls. All data calls use API version 2 (header `Databucket-Api-Version: 2`).
 */
export class Databucket {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly fetchFn: typeof fetch;
  private readonly logger: ((message: string) => void) | undefined;
  private readonly signInFn: SignIn | undefined;
  private readonly projectId: number | undefined;
  private readonly projectName: string | undefined;

  private currentToken: string | undefined;
  private signingIn: Promise<string> | undefined;
  private currentProject: Project | undefined;

  constructor(options: DatabucketOptions) {
    if (!options?.url || !options.url.trim()) throw new TypeError('The Databucket url is empty');
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.timeout = options.timeout ?? 30_000;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    if (!this.fetchFn) throw new TypeError('No fetch available: use Node.js 20.19+ or pass fetch in the options');
    this.logger = options.logger;
    if (typeof options.project === 'number') this.projectId = options.project;
    else if (typeof options.project === 'string') this.projectName = options.project;
    this.currentToken = options.token;

    if (options.username !== undefined || options.password !== undefined) {
      if (!options.username || options.password === undefined)
        throw new TypeError('Sign-in with a password needs both username and password');
      const { username, password } = options;
      this.signInFn = (projectId) =>
        this.signInCall('/api/public/signin', { username, password, ...(projectId !== undefined && { projectId }) });
    } else if (options.ssoToken) {
      const ssoToken = options.ssoToken;
      this.signInFn = async (projectId) =>
        this.signInCall('/api/public/sso/token-exchange', {
          token: await ssoToken(),
          ...(projectId !== undefined && { projectId }),
        });
    }
    if (!this.signInFn && !this.currentToken)
      throw new TypeError('No credentials: give username and password, ssoToken or token');
  }

  /** A bucket; `T` is the type of its properties (default: a plain object). */
  bucket<T = Record<string, any>>(name: string): Bucket<T> {
    return new Bucket<T>(this, name);
  }

  /** The project the client works in (signs in if not done yet); undefined when only a token was given. */
  async project(): Promise<Project | undefined> {
    await this.token();
    return this.currentProject;
  }

  /** The current access token (signs in if needed). */
  async token(): Promise<string> {
    if (this.currentToken) return this.currentToken;
    if (!this.signingIn) {
      this.signingIn = this.signIn().finally(() => {
        this.signingIn = undefined;
      });
    }
    return this.signingIn;
  }

  // ---------------------------------------------------------------- sign-in

  private async signIn(): Promise<string> {
    if (!this.signInFn) throw new Error('No credentials: give username and password, ssoToken or token');

    let id = this.projectId;
    let response = await this.signInFn(id);
    if (id === undefined && !response?.token && Array.isArray(response?.projects)) {
      // the user has several projects: pick one by name
      id = this.pickProject(response.projects);
      response = await this.signInFn(id);
    }
    if (this.projectName !== undefined && id === undefined && response?.project && response.project.name !== this.projectName)
      throw new DatabucketError(0, `The user is not assigned to the project '${this.projectName}'`);

    if (!response?.token || response.changePassword)
      throw new DatabucketError(
        0,
        'Sign-in gave no token for a project' + (response?.changePassword ? ': the user has to change the password first' : ''),
        JSON.stringify(response),
      );

    this.currentProject = response.project ? { id: response.project.id, name: response.project.name } : undefined;
    this.currentToken = response.token as string;
    this.log(`Signed in to project ${this.currentProject?.name} (${this.currentProject?.id})`);
    return this.currentToken;
  }

  private pickProject(projects: Array<{ id: number; name: string }>): number {
    const match = projects.find((p) => p.name === this.projectName);
    if (match) return match.id;
    const names = projects.map((p) => p.name).join(', ');
    throw new DatabucketError(
      0,
      this.projectName === undefined
        ? `The user has several projects, choose one with the 'project' option: [${names}]`
        : `The user is not assigned to the project '${this.projectName}'; projects: [${names}]`,
    );
  }

  private async signInCall(path: string, body: Record<string, unknown>): Promise<any> {
    const response = await this.send('POST', path, { 'Content-Type': 'application/json' }, JSON.stringify(body));
    return this.handle('POST', path, response);
  }

  // ---------------------------------------------------------------- HTTP

  /** @internal A call of the data API (version 2) with the token; signs in again once on 401. */
  async call(method: string, path: string, body?: unknown, retry = true): Promise<any> {
    const token = await this.token();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      [API_VERSION_HEADER]: API_VERSION,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.send(method, path, headers, body === undefined ? undefined : JSON.stringify(body));

    if (response.status === 401 && retry && this.signInFn) {
      // the token expired: sign in again once
      if (this.currentToken === token) this.currentToken = undefined;
      return this.call(method, path, body, false);
    }
    return this.handle(method, path, response);
  }

  private async send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
    const url = this.baseUrl + path;
    const start = Date.now();
    try {
      const response = await this.fetchFn(url, {
        method,
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
        body,
        signal: AbortSignal.timeout(this.timeout),
      });
      const text = await response.text();
      this.log(`${method} ${url} -> ${response.status} (${Date.now() - start} ms)`);
      return { status: response.status, text };
    } catch (e) {
      const reason = e instanceof Error ? (e.name === 'TimeoutError' ? `timeout after ${this.timeout} ms` : e.message) : String(e);
      throw new DatabucketError(0, `${method} ${url} failed: ${reason}`, undefined, { cause: e });
    }
  }

  private handle(method: string, path: string, response: { status: number; text: string }): any {
    const json = parse(response.text);
    if (response.status >= 400) {
      const message =
        json?.message ?? json?.error ?? (response.text.trim() ? response.text : 'no response body');
      throw new DatabucketError(response.status, `${message} (${method} ${path.split('?')[0]})`, response.text);
    }
    return json;
  }

  private log(message: string) {
    this.logger?.(message);
  }
}

function parse(text: string): any {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
