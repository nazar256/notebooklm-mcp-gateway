export const notebookLmScopes = [
  "notebooklm:read",
  "notebooklm:chat",
  "notebooklm:write",
  "notebooklm:delete",
  "notebooklm:share"
] as const;

export type NotebookLMScope = typeof notebookLmScopes[number];

export const baselineScope: NotebookLMScope = "notebooklm:read";

export const scopeLabels: Record<NotebookLMScope, { title: string; description: string }> = {
  "notebooklm:read": { title: "Read NotebookLM content", description: "Read notebooks, sources, notes, chats, artifacts, and sharing status." },
  "notebooklm:chat": { title: "Chat and generate artifacts", description: "Ask questions, start research, and generate Studio artifacts." },
  "notebooklm:write": { title: "Create and edit NotebookLM content", description: "Create/edit notebooks, sources, notes, refresh sources, and import research sources." },
  "notebooklm:delete": { title: "Delete NotebookLM content", description: "Delete notebooks, sources, and notes." },
  "notebooklm:share": { title: "Change public sharing", description: "Change public link sharing for notebooks." }
};

const scopeSet = new Set<string>(notebookLmScopes);

export function parseRequestedScopes(scope: string | undefined): NotebookLMScope[] {
  const requested = parseScopeString(scope);
  if (requested.length === 0) return [baselineScope];
  if (!requested.includes(baselineScope)) throw new Error("invalid_request");
  return requested;
}

export function parseGrantedScopes(scope: string): NotebookLMScope[] {
  const granted = parseScopeString(scope);
  if (!granted.includes(baselineScope)) throw new Error("invalid_grant");
  return granted;
}

export function formatScopes(scopes: Iterable<NotebookLMScope>): string {
  const granted = new Set(scopes);
  return notebookLmScopes.filter((scope) => granted.has(scope)).join(" ");
}

export function grantScopesFromConsent(requested: NotebookLMScope[], selected: Iterable<NotebookLMScope>): NotebookLMScope[] {
  const requestedSet = new Set(requested);
  const selectedSet = new Set(selected);
  return notebookLmScopes.filter((scope) => scope === baselineScope || (requestedSet.has(scope) && selectedSet.has(scope)));
}

export function hasRequiredScopes(granted: readonly NotebookLMScope[], required: readonly NotebookLMScope[]): boolean {
  const grantedSet = new Set(granted);
  return required.every((scope) => grantedSet.has(scope));
}

export const toolScopeRequirements: Record<string, readonly NotebookLMScope[]> = {
  list_notebooks: ["notebooklm:read"],
  get_notebook: ["notebooklm:read"],
  list_sources: ["notebooklm:read"],
  get_source_guide: ["notebooklm:read"],
  get_source_content: ["notebooklm:read"],
  get_last_conversation_id: ["notebooklm:read"],
  get_conversation_turns: ["notebooklm:read"],
  list_notes: ["notebooklm:read"],
  list_artifacts: ["notebooklm:read"],
  download_artifact: ["notebooklm:read"],
  poll_research: ["notebooklm:read"],
  get_share_status: ["notebooklm:read"],
  ask_notebook: ["notebooklm:chat"],
  start_research: ["notebooklm:chat"],
  generate_artifact: ["notebooklm:chat"],
  create_notebook: ["notebooklm:write"],
  rename_notebook: ["notebooklm:write"],
  add_url_source: ["notebooklm:write"],
  add_youtube_source: ["notebooklm:write"],
  add_text_source: ["notebooklm:write"],
  add_drive_source: ["notebooklm:write"],
  refresh_source: ["notebooklm:write"],
  create_note: ["notebooklm:write"],
  update_note: ["notebooklm:write"],
  import_research_sources: ["notebooklm:write"],
  delete_notebook: ["notebooklm:delete"],
  delete_source: ["notebooklm:delete"],
  delete_note: ["notebooklm:delete"],
  set_share_public: ["notebooklm:share"]
};

export function requiredScopesForTool(toolName: string): readonly NotebookLMScope[] {
  return toolScopeRequirements[toolName] ?? [];
}

function parseScopeString(scope: string | undefined): NotebookLMScope[] {
  const parts = (scope ?? "").trim().split(/\s+/).filter(Boolean);
  const unique = new Set<NotebookLMScope>();
  for (const part of parts) {
    if (!scopeSet.has(part)) throw new Error("invalid_request");
    unique.add(part as NotebookLMScope);
  }
  return notebookLmScopes.filter((candidate) => unique.has(candidate));
}
