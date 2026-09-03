/**
 * @xtnd-dynamics/mcp-gmail Library Exports
 */

export * from './types.js';
export { GmailClient, type GmailClientOptions } from './core/client.js';
export { GmailRestClient, GmailApiError } from './core/gmail/rest.js';
export {
  buildAuthorizationUrl,
  createPkcePair,
  createStateToken,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  OAuthError,
  type TokenSet,
} from './core/auth/oauth.js';
export {
  GMAIL_SCOPES,
  DEFAULT_SCOPES,
  PERMANENT_DELETE_SCOPES,
  MissingScopeError,
  assertScope,
  grantSatisfies,
  type GmailScope,
} from './core/auth/scopes.js';
export { parseMessage, parseAddressList, decodeBase64Url } from './core/parser/payload.js';
export { composeMimeMessage, toGmailRaw, buildReplyHeaders } from './core/parser/rfc822.js';
export { htmlToMarkdown, truncateForAI } from './core/parser/markdown.js';
export { createGmailMcpServer } from './mcp/server.js';
