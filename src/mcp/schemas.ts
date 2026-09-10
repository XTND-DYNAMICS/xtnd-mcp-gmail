/**
 * MCP Tool Input Schemas (Zod)
 *
 * Every string that can reach a header, a Gmail query, or a resource path is
 * length-bounded and rejects control characters, so a tool argument can never
 * smuggle a newline into a composed message or an API path.
 */

import { z } from 'zod';

function withoutControls(schema: z.ZodString) {
  return schema.refine(
    (value) => !/[\u0000\r\n]/.test(value),
    'Value cannot contain NUL, carriage return, or line feed characters',
  );
}

/** Gmail resource ids are hex-ish opaque tokens; constrain them tightly. */
const ResourceId = z.string().min(1).max(256).regex(
  /^[A-Za-z0-9_-]+$/,
  'Gmail identifiers contain only letters, digits, underscores, and hyphens',
);
const LabelId = z.string().min(1).max(256).regex(
  /^[A-Za-z0-9_\-/]+$/,
  'Label identifiers contain only letters, digits, underscores, hyphens, and slashes',
);
const LabelIds = z.array(LabelId).min(1).max(100);
const SearchQuery = withoutControls(z.string().max(2_048));
const SubjectText = withoutControls(z.string().max(998));
const HeaderValue = withoutControls(z.string().min(1).max(1_000));
const Recipient = z.union([HeaderValue, z.array(HeaderValue).min(1).max(100)]);
const BodyText = z.string().max(1_000_000);
const BodyHtml = z.string().max(2_000_000);
const PageToken = z.string().min(1).max(4_096);
const Limit = z.number().int().min(1).max(500);

const Attachment = z.object({
  filename: withoutControls(z.string().min(1).max(255)),
  contentType: withoutControls(z.string().min(1).max(255)).optional(),
  dataBase64: z.string().max(35_000_000).optional(),
  filePath: z.string().max(4_096).optional(),
}).strict();

const Attachments = z.union([
  z.array(Attachment).max(25),
  z.array(z.string().max(4_096)).max(25),
]);

// ------------------------------------------------------------------ account

export const GetProfileSchema = z.object({}).strict();

export const ListHistorySchema = z.object({
  startHistoryId: z.string().min(1).max(64).regex(/^\d+$/, 'historyId is a decimal string'),
  limit: Limit.optional().describe('Maximum number of history records to return'),
}).strict();

// ------------------------------------------------------------------- search

export const SearchMessagesSchema = z.object({
  query: SearchQuery.optional().describe(
    'Native Gmail search syntax, e.g. "from:a@b.com is:unread newer_than:7d has:attachment"',
  ),
  labelIds: LabelIds.optional().describe('Restrict to these label IDs (use list_labels to resolve names)'),
  includeSpamTrash: z.boolean().optional().default(false).describe('Include SPAM and TRASH in results'),
  limit: Limit.optional().default(20).describe('Maximum number of messages to return'),
  pageToken: PageToken.optional().describe('Continuation token from a previous call'),
}).strict();

export const ListThreadsSchema = z.object({
  query: SearchQuery.optional().describe('Native Gmail search syntax applied to threads'),
  labelIds: LabelIds.optional().describe('Restrict to these label IDs'),
  includeSpamTrash: z.boolean().optional().default(false).describe('Include SPAM and TRASH in results'),
  limit: Limit.optional().default(20).describe('Maximum number of threads to return'),
  pageToken: PageToken.optional().describe('Continuation token from a previous call'),
}).strict();

// --------------------------------------------------------------------- read

export const GetMessageSchema = z.object({
  messageId: ResourceId.describe('Gmail message ID'),
  format: z.enum(['markdown', 'text', 'html', 'raw']).optional().default('markdown')
    .describe('Body representation to return. Markdown is the most token-efficient.'),
}).strict();

export const GetThreadSchema = z.object({
  threadId: ResourceId.describe('Gmail thread ID'),
  includeBodies: z.boolean().optional().default(false)
    .describe('Return each message body rather than a snippet. Costly on long threads.'),
}).strict();

export const GetAttachmentSchema = z.object({
  messageId: ResourceId.describe('Gmail message ID that carries the attachment'),
  attachmentId: z.string().min(1).max(2_048).describe('Attachment ID from get_message'),
  saveToPath: z.string().min(1).max(4_096).optional()
    .describe('Absolute path to write the decoded file to. Omit to return base64 inline.'),
}).strict();

// ----------------------------------------------------------------- outbound

export const SendMessageSchema = z.object({
  to: Recipient.describe('Recipient email address or list of addresses'),
  subject: SubjectText.describe('Email subject line'),
  bodyText: BodyText.describe('Plain text body of the email'),
  bodyHtml: BodyHtml.optional().describe('Optional HTML version of the body'),
  cc: Recipient.optional().describe('Optional CC recipient(s)'),
  bcc: Recipient.optional().describe('Optional BCC recipient(s)'),
  from: HeaderValue.optional().describe('Send-as alias. Must be a verified alias on the account.'),
  attachments: Attachments.optional().describe('Files to attach (file paths or base64 objects)'),
  attachEmailIds: z.array(ResourceId).optional().describe('Email message IDs to attach as .eml attachments'),
}).strict();

export const ReplyMessageSchema = z.object({
  messageId: ResourceId.describe('Gmail message ID being replied to'),
  bodyText: BodyText.describe('Reply body'),
  bodyHtml: BodyHtml.optional().describe('Optional HTML reply body'),
  replyAll: z.boolean().optional().default(false).describe('Include every original recipient'),
  from: HeaderValue.optional().describe('Send-as alias to reply from'),
  attachments: Attachments.optional().describe('Optional files to attach'),
  attachEmailIds: z.array(ResourceId).optional().describe('Email message IDs to attach as .eml attachments'),
}).strict();

export const ForwardMessageSchema = z.object({
  messageId: ResourceId.describe('Gmail message ID to forward'),
  to: Recipient.describe('Recipient(s) to forward to'),
  comment: BodyText.optional().describe('Optional note prepended above the forwarded message'),
  from: HeaderValue.optional().describe('Send-as alias to forward from'),
  attachments: Attachments.optional().describe('Optional files to attach'),
  attachAsEml: z.boolean().optional().default(false).describe('If true, attach the original message as a full .eml file'),
}).strict();

// ------------------------------------------------------------------- drafts

export const CreateDraftSchema = z.object({
  to: Recipient.optional().describe('Recipient email address or list of addresses'),
  subject: SubjectText.optional().describe('Email subject line'),
  bodyText: BodyText.optional().default('').describe('Draft body text'),
  bodyHtml: BodyHtml.optional().describe('Optional HTML draft body'),
  cc: Recipient.optional().describe('Optional CC recipient(s)'),
  bcc: Recipient.optional().describe('Optional BCC recipient(s)'),
  from: HeaderValue.optional().describe('Send-as alias the draft will be sent from'),
  threadId: ResourceId.optional().describe('Attach the draft to an existing thread'),
  attachments: Attachments.optional().describe('Files to attach (file paths or base64 objects)'),
  attachEmailIds: z.array(ResourceId).optional().describe('Email message IDs to attach as .eml attachments'),
}).strict();

export const UpdateDraftSchema = CreateDraftSchema.extend({
  draftId: ResourceId.describe('Draft ID to replace'),
}).strict();

export const GetDraftSchema = z.object({
  draftId: ResourceId.describe('Draft ID'),
}).strict();

export const ListDraftsSchema = z.object({
  limit: Limit.optional().default(20).describe('Maximum number of drafts to return'),
  pageToken: PageToken.optional().describe('Continuation token from a previous call'),
}).strict();

export const SendDraftSchema = z.object({
  draftId: ResourceId.describe('Draft ID to send'),
}).strict();

export const DeleteDraftSchema = z.object({
  draftId: ResourceId.describe('Draft ID to delete'),
}).strict();

// ------------------------------------------------------------------- labels

export const ListLabelsSchema = z.object({}).strict();

export const GetLabelSchema = z.object({
  labelId: LabelId.describe('Label ID'),
}).strict();

const LabelVisibility = z.object({
  messageListVisibility: z.enum(['show', 'hide']).optional(),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional(),
  color: z.object({
    textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }).strict().optional(),
});

export const CreateLabelSchema = LabelVisibility.extend({
  name: withoutControls(z.string().min(1).max(225)).describe('Label name. Use "Parent/Child" for nesting.'),
}).strict();

export const UpdateLabelSchema = LabelVisibility.extend({
  labelId: LabelId.describe('Label ID to update'),
  name: withoutControls(z.string().min(1).max(225)).optional().describe('New label name'),
}).strict();

export const DeleteLabelSchema = z.object({
  labelId: LabelId.describe('Label ID to delete. Removes it from every message it is on.'),
}).strict();

export const ModifyMessageLabelsSchema = z.object({
  messageId: ResourceId.describe('Gmail message ID'),
  addLabelIds: LabelIds.optional().describe('Label IDs to add'),
  removeLabelIds: LabelIds.optional().describe('Label IDs to remove'),
}).strict();

export const ModifyThreadLabelsSchema = z.object({
  threadId: ResourceId.describe('Gmail thread ID'),
  addLabelIds: LabelIds.optional().describe('Label IDs to add'),
  removeLabelIds: LabelIds.optional().describe('Label IDs to remove'),
}).strict();

export const BatchModifyLabelsSchema = z.object({
  messageIds: z.array(ResourceId).min(1).max(1_000).describe('Message IDs to update in one call'),
  addLabelIds: LabelIds.optional().describe('Label IDs to add'),
  removeLabelIds: LabelIds.optional().describe('Label IDs to remove'),
}).strict();

// ------------------------------------------------------------------ triage

export const TrashMessageSchema = z.object({
  messageId: ResourceId.describe('Gmail message ID to move to Trash'),
}).strict();

export const UntrashMessageSchema = z.object({
  messageId: ResourceId.describe('Gmail message ID to restore from Trash'),
}).strict();

export const TrashThreadSchema = z.object({
  threadId: ResourceId.describe('Gmail thread ID to move to Trash'),
}).strict();

export const UntrashThreadSchema = z.object({
  threadId: ResourceId.describe('Gmail thread ID to restore from Trash'),
}).strict();

export const DeleteMessagePermanentlySchema = z.object({
  messageId: ResourceId.describe('Gmail message ID to delete irreversibly'),
  confirm: z.literal(true).describe('Must be true. Bypasses Trash and cannot be undone.'),
}).strict();

export const DeleteThreadPermanentlySchema = z.object({
  threadId: ResourceId.describe('Gmail thread ID to delete irreversibly'),
  confirm: z.literal(true).describe('Must be true. Bypasses Trash and cannot be undone.'),
}).strict();

// ----------------------------------------------------------------- settings

export const ListFiltersSchema = z.object({}).strict();

export const CreateFilterSchema = z.object({
  from: SearchQuery.optional().describe('Match messages from this sender'),
  to: SearchQuery.optional().describe('Match messages to this recipient'),
  subject: SubjectText.optional().describe('Match this subject text'),
  query: SearchQuery.optional().describe('Match this Gmail search expression'),
  negatedQuery: SearchQuery.optional().describe('Exclude messages matching this expression'),
  hasAttachment: z.boolean().optional().describe('Match only messages with attachments'),
  addLabelIds: LabelIds.optional().describe('Label IDs to apply to matches'),
  removeLabelIds: LabelIds.optional().describe('Label IDs to strip from matches, e.g. INBOX to archive'),
  forward: HeaderValue.optional().describe('Forward matches to this verified address'),
}).strict();

export const DeleteFilterSchema = z.object({
  filterId: z.string().min(1).max(256).describe('Filter ID from list_filters'),
}).strict();

export const ListSendAsSchema = z.object({}).strict();

export const UpdateSendAsSchema = z.object({
  sendAsEmail: HeaderValue.describe('Alias address to update'),
  displayName: withoutControls(z.string().max(255)).optional().describe('Display name for the alias'),
  replyToAddress: HeaderValue.optional().describe('Reply-To address for the alias'),
  signature: BodyHtml.optional().describe('HTML signature for the alias'),
  isDefault: z.boolean().optional().describe('Make this the default sending address'),
}).strict();

export const GetVacationSchema = z.object({}).strict();

export const UpdateVacationSchema = z.object({
  enableAutoReply: z.boolean().describe('Turn the vacation responder on or off'),
  responseSubject: SubjectText.optional().describe('Subject of the auto-reply'),
  responseBodyPlainText: BodyText.optional().describe('Plain text auto-reply body'),
  responseBodyHtml: BodyHtml.optional().describe('HTML auto-reply body'),
  restrictToContacts: z.boolean().optional().describe('Only auto-reply to known contacts'),
  restrictToDomain: z.boolean().optional().describe('Only auto-reply within the account domain'),
  startTime: z.string().regex(/^\d+$/).optional().describe('Start as epoch milliseconds'),
  endTime: z.string().regex(/^\d+$/).optional().describe('End as epoch milliseconds'),
}).strict();

export const ListForwardingAddressesSchema = z.object({}).strict();

export const GetAutoForwardingSchema = z.object({}).strict();

export const UpdateAutoForwardingSchema = z.object({
  enabled: z.boolean().describe('Turn auto-forwarding on or off'),
  emailAddress: HeaderValue.optional().describe('Verified forwarding address. Required when enabling.'),
  disposition: z.enum(['leaveInInbox', 'archive', 'trash', 'markRead']).optional()
    .describe('What to do with the local copy of each forwarded message'),
  confirm: z.literal(true).describe('Must be true. Auto-forwarding copies every inbound message off the account.'),
}).strict();

export const ListDelegatesSchema = z.object({}).strict();

export const RemoveDelegateSchema = z.object({
  delegateEmail: HeaderValue.describe('Delegate address to remove'),
}).strict();

// ------------------------------------------------------------- Direct / IMAP aliases
export const ListFoldersSchema = z.object({}).strict();
export const CreateFolderSchema = z.object({ name: z.string().min(1).max(256) }).strict();
export const RenameFolderSchema = z.object({ oldName: z.string().min(1), newName: z.string().min(1) }).strict();
export const DeleteFolderSchema = z.object({ name: z.string().min(1) }).strict();
export const SearchEmailsSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  query: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  unreadOnly: z.boolean().optional().default(false),
  limit: z.number().optional().default(20),
});
export const GetRecentEmailsSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  limit: z.number().optional().default(10),
});
export const GetEmailContentSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  uid: z.number(),
  format: z.enum(['markdown', 'text', 'html']).optional().default('markdown'),
});
export const GetEmailThreadSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  uidOrMessageId: z.string(),
});
export const MarkEmailsSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  uids: z.array(z.number()),
  action: z.enum(['read', 'unread', 'flag', 'unflag']),
});
export const MoveEmailsSchema = z.object({
  sourceFolder: z.string().optional().default('INBOX'),
  targetFolder: z.string(),
  uids: z.array(z.number()),
});
export const DeleteEmailsSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  uids: z.array(z.number()),
  permanent: z.boolean().optional().default(false),
});
export const SendEmailSchema = z.object({
  to: z.string(),
  subject: z.string(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
});
export const ReplyEmailSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  uid: z.number(),
  bodyText: z.string(),
  replyAll: z.boolean().optional().default(false),
  bodyHtml: z.string().optional(),
});
export const ForwardEmailSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  uid: z.number(),
  to: z.string(),
  comment: z.string().optional(),
});
export const UpdateDraftDirectSchema = z.object({
  draftId: z.string(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
});
export const ListDraftsDirectSchema = z.object({
  limit: z.number().optional().default(20),
});
export const GetDraftDirectSchema = z.object({
  draftId: z.string(),
});
export const SendDraftDirectSchema = z.object({
  draftId: z.string(),
});
export const DeleteDraftDirectSchema = z.object({
  draftId: z.string(),
});
export const ArchiveEmailDirectSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  id: z.string(),
});
export const StarEmailDirectSchema = z.object({
  folder: z.string().optional().default('INBOX'),
  id: z.string(),
  star: z.boolean().default(true),
});
export const UntrashEmailDirectSchema = z.object({
  id: z.string(),
});
