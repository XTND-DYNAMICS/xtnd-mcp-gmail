/**
 * Account and settings tools.
 *
 * Everything here changes persistent account configuration rather than
 * individual messages, so the write tools describe their blast radius in the
 * tool text itself. Auto-forwarding additionally requires an explicit confirm,
 * because enabling it silently copies every inbound message off the account.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GmailClient } from '../../core/client.js';
import {
  CreateFilterSchema,
  DeleteFilterSchema,
  GetAutoForwardingSchema,
  GetProfileSchema,
  GetVacationSchema,
  ListDelegatesSchema,
  ListFiltersSchema,
  ListForwardingAddressesSchema,
  ListHistorySchema,
  ListSendAsSchema,
  RemoveDelegateSchema,
  UpdateAutoForwardingSchema,
  UpdateSendAsSchema,
  UpdateVacationSchema,
} from '../schemas.js';
import { run } from './respond.js';

export function registerSettingsTools(server: McpServer, getClient: () => GmailClient) {
  // ---------------------------------------------------------------- account

  server.tool(
    'get_profile',
    'Return the authenticated mailbox address plus total message and thread counts. Use it to '
    + 'confirm which account this server is connected to.',
    GetProfileSchema.shape,
    async () => run('get_profile', async () => getClient().getProfile()),
  );

  server.tool(
    'list_history',
    'List mailbox changes since a known historyId. The efficient way to detect what changed '
    + 'without re-scanning the mailbox; get a starting historyId from get_profile.',
    ListHistorySchema.shape,
    async (args) => run('list_history', async () => {
      const page = await getClient().listHistory(args.startHistoryId, args.limit);
      return { count: page.items.length, nextPageToken: page.nextPageToken, history: page.items };
    }),
  );

  // ---------------------------------------------------------------- filters

  server.tool(
    'list_filters',
    'List every server-side filter with its criteria and actions.',
    ListFiltersSchema.shape,
    async () => run('list_filters', async () => {
      const filters = await getClient().listFilters();
      return { count: filters.length, filters };
    }),
  );

  server.tool(
    'create_filter',
    'Create a server-side filter. Filters apply to mail arriving from now on, not retroactively. '
    + 'Remove the INBOX label to auto-archive matches.',
    CreateFilterSchema.shape,
    async (args) => run('create_filter', async () => {
      const filter = await getClient().createFilter({
        criteria: {
          from: args.from,
          to: args.to,
          subject: args.subject,
          query: args.query,
          negatedQuery: args.negatedQuery,
          hasAttachment: args.hasAttachment,
        },
        action: {
          addLabelIds: args.addLabelIds,
          removeLabelIds: args.removeLabelIds,
          forward: args.forward,
        },
      });
      return { created: true, filterId: filter.id, criteria: filter.criteria, action: filter.action };
    }),
  );

  server.tool(
    'delete_filter',
    'Delete a server-side filter. Mail it already acted on is unaffected.',
    DeleteFilterSchema.shape,
    async (args) => run('delete_filter', async () => {
      await getClient().deleteFilter(args.filterId);
      return { deleted: true, filterId: args.filterId };
    }),
  );

  // ---------------------------------------------------------------- send-as

  server.tool(
    'list_send_as',
    'List send-as aliases, their verification status, and their signatures. Only verified aliases '
    + 'can be used as the "from" argument on send tools.',
    ListSendAsSchema.shape,
    async () => run('list_send_as', async () => {
      const aliases = await getClient().listSendAs();
      return { count: aliases.length, sendAs: aliases };
    }),
  );

  server.tool(
    'update_send_as',
    'Update an alias: display name, reply-to, signature, or make it the default sending address.',
    UpdateSendAsSchema.shape,
    async (args) => run('update_send_as', async () => {
      const alias = await getClient().updateSendAs(args.sendAsEmail, {
        displayName: args.displayName,
        replyToAddress: args.replyToAddress,
        signature: args.signature,
        isDefault: args.isDefault,
      });
      return { updated: true, sendAsEmail: alias.sendAsEmail, isDefault: alias.isDefault };
    }),
  );

  // --------------------------------------------------------------- vacation

  server.tool(
    'get_vacation',
    'Read the vacation responder configuration.',
    GetVacationSchema.shape,
    async () => run('get_vacation', async () => getClient().getVacation()),
  );

  server.tool(
    'update_vacation',
    'Turn the vacation auto-responder on or off and set its message and date window. Everyone who '
    + 'writes to the account while it is on receives the reply.',
    UpdateVacationSchema.shape,
    async (args) => run('update_vacation', async () => {
      const settings = await getClient().updateVacation({
        enableAutoReply: args.enableAutoReply,
        responseSubject: args.responseSubject,
        responseBodyPlainText: args.responseBodyPlainText,
        responseBodyHtml: args.responseBodyHtml,
        restrictToContacts: args.restrictToContacts,
        restrictToDomain: args.restrictToDomain,
        startTime: args.startTime,
        endTime: args.endTime,
      });
      return { updated: true, enabled: settings.enableAutoReply, subject: settings.responseSubject };
    }),
  );

  // ------------------------------------------------------------- forwarding

  server.tool(
    'list_forwarding_addresses',
    'List forwarding addresses and whether Google has verified them.',
    ListForwardingAddressesSchema.shape,
    async () => run('list_forwarding_addresses', async () => {
      const addresses = await getClient().listForwardingAddresses();
      return { count: addresses.length, forwardingAddresses: addresses };
    }),
  );

  server.tool(
    'get_auto_forwarding',
    'Read whether all inbound mail is being auto-forwarded, and to where.',
    GetAutoForwardingSchema.shape,
    async () => run('get_auto_forwarding', async () => getClient().getAutoForwarding()),
  );

  server.tool(
    'update_auto_forwarding',
    'Enable or disable forwarding of ALL inbound mail to another address. This is a standing rule '
    + 'that keeps copying mail off the account until it is turned off; never enable it without the '
    + 'account owner explicitly asking. The address must already be verified.',
    UpdateAutoForwardingSchema.shape,
    async (args) => run('update_auto_forwarding', async () => {
      const settings = await getClient().updateAutoForwarding({
        enabled: args.enabled,
        emailAddress: args.emailAddress,
        disposition: args.disposition,
      });
      return { updated: true, enabled: settings.enabled, emailAddress: settings.emailAddress };
    }),
  );

  // -------------------------------------------------------------- delegates

  server.tool(
    'list_delegates',
    'List accounts delegated access to this mailbox. Google Workspace only.',
    ListDelegatesSchema.shape,
    async () => run('list_delegates', async () => {
      const delegates = await getClient().listDelegates();
      return { count: delegates.length, delegates };
    }),
  );

  server.tool(
    'remove_delegate',
    'Revoke a delegate\'s access to this mailbox. Adding a delegate is deliberately not exposed: '
    + 'granting another account access to a mailbox is an action the owner should take in Gmail.',
    RemoveDelegateSchema.shape,
    async (args) => run('remove_delegate', async () => {
      await getClient().removeDelegate(args.delegateEmail);
      return { removed: true, delegateEmail: args.delegateEmail };
    }),
  );
}
