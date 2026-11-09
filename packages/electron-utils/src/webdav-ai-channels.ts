/**
 * The channels an editor's AI uses to browse, search and read the WebDAV
 * servers the person connected (decision 0118). The shell's main process
 * answers them; it alone holds the servers and passwords, and it refuses them
 * while the person has not let the AI use WebDAV.
 */
export const WEBDAV_AI_CHANNELS = {
  enabled: 'webdav:ai-enabled',
  list: 'webdav:ai-list',
  search: 'webdav:ai-search',
  read: 'webdav:ai-read',
  /** main → every window: whether the AI may use WebDAV now (payload: boolean) */
  changed: 'webdav:ai-changed',
} as const
