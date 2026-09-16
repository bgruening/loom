/**
 * What a `notebook_anchor` is allowed to point at.
 *
 * `galaxy_invocation_record` / `galaxy_job_record` take a `notebookAnchor` and
 * write it into the block verbatim. Nothing checked it, so a model that typed
 * `plan-1-step-3` where the notebook says `plan-a-step-1` produced a block that
 * binds to no step at all: the Activity panel still shows the run, the poller
 * still advances it, and the evidence gate -- which looks a step's anchor up
 * among the blocks (`findContradictions`) -- silently has nothing to compare.
 * A binding that quietly points nowhere is worse than a rejected call, because
 * every downstream check reads as "no opinion" rather than "broken".
 *
 * Two things count as an anchor, matching what the plan convention
 * (`context.ts`) teaches and what `init-gate.ts` parses:
 *
 *   - an explicit `{#plan-a-step-1}` marker, which is what steps carry;
 *   - a markdown heading, via its GitHub-style slug, which is the fallback for
 *     a notebook written without explicit anchors -- including the Llama-4
 *     path, where `buildPlanConventionBlock` deliberately tells the model *not*
 *     to write `{#...}` because the proxy in front of it reads a curly brace as
 *     a tool-call boundary.
 *
 * Fenced content is excluded, for the reason `parsePlanSteps` excludes it: a
 * plan draft pasted inside a ```plan fence is quoted, not asserted, and the
 * `loom-invocation` blocks are themselves fences. Without that, a block's own
 * `notebook_anchor:` line would make every later record call for that anchor
 * validate against a record we wrote ourselves.
 */

/** `{#some-id}` -- same shape `evidence-gate.ts` reads off a step line. */
const ANCHOR = /\{#([^}]+)\}/g;
/** A markdown ATX heading; setext headings aren't used in Loom notebooks. */
const HEADING = /^(#{1,6})\s+(.*)$/;
/** Any fence opener or closer, matching parsePlanSteps' toggle. */
const FENCE = /^\s*(```|~~~)/;

/** How many anchors a rejection names before it starts summarizing. */
const MAX_LISTED_ANCHORS = 20;

export interface NotebookAnchors {
  /** Explicit `{#id}` markers, in document order, spelled as written. */
  explicit: string[];
  /** Slugs derived from headings, in document order. */
  headings: string[];
}

/**
 * Slugify heading text the way GitHub does: drop the inline markup, lowercase,
 * strip punctuation, spaces to hyphens. `## Plan A: chrM Variant Calling
 * [galaxy]` becomes `plan-a-chrm-variant-calling-galaxy`.
 */
export function slugifyHeading(text: string): string {
  return text
    .replace(ANCHOR, "")
    .replace(/[*_`~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Every anchor the notebook offers, split by how it was written. */
export function collectNotebookAnchors(content: string): NotebookAnchors {
  const explicit: string[] = [];
  const headings: string[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(ANCHOR)) {
      const id = m[1].trim();
      if (id) explicit.push(id);
    }
    const heading = line.match(HEADING);
    if (heading) {
      const slug = slugifyHeading(heading[2]);
      if (slug) headings.push(slug);
    }
  }
  return { explicit, headings };
}

/**
 * The anchors a record call may name, de-duplicated, explicit markers first.
 * Order is what a rejection message lists, and an explicit anchor is the one
 * the author meant to be addressable.
 */
export function listNotebookAnchors(content: string): string[] {
  const { explicit, headings } = collectNotebookAnchors(content);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const anchor of [...explicit, ...headings]) {
    const key = anchor.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(anchor);
  }
  return out;
}

/**
 * Strip the spellings a model copies out of the markdown -- `{#step-1}`,
 * `#step-1` -- down to the bare id.
 */
function normalizeAnchorInput(raw: string): string {
  let value = raw.trim();
  const braced = value.match(/^\{(.+)\}$/);
  if (braced) value = braced[1];
  return value.replace(/^#+/, "").trim();
}

/**
 * Resolve `input` against the notebook, returning the anchor **as the notebook
 * spells it** or null when nothing matches.
 *
 * Canonicalizing rather than echoing the input back matters: the evidence gate
 * matches a block's `notebook_anchor` against a step's anchor verbatim, so
 * storing a case-drifted copy would record a block bound to nothing while
 * looking fine in the file.
 */
export function resolveNotebookAnchor(content: string, input: string): string | null {
  const wanted = normalizeAnchorInput(input);
  if (!wanted) return null;
  const { explicit, headings } = collectNotebookAnchors(content);
  const lowered = wanted.toLowerCase();
  for (const candidate of explicit) {
    if (candidate === wanted) return candidate;
  }
  for (const candidate of explicit) {
    if (candidate.toLowerCase() === lowered) return candidate;
  }
  for (const candidate of headings) {
    if (candidate === lowered) return candidate;
  }
  return null;
}

/** The refusal a record tool hands back, naming what the notebook does have. */
export function unknownAnchorMessage(input: string, anchors: string[]): string {
  const wanted = normalizeAnchorInput(input) || input.trim();
  if (anchors.length === 0) {
    return (
      `Unknown notebook anchor "${wanted}": notebook.md has no headings or {#anchor} ` +
      `markers to bind to, so this block would point at nothing. Write the step first ` +
      `-- \`- [ ] 1. **Step name** {#${wanted}} -- description\` -- then record against it.`
    );
  }
  const shown = anchors.slice(0, MAX_LISTED_ANCHORS);
  const extra = anchors.length - shown.length;
  const tail = extra > 0 ? `, and ${extra} more` : "";
  return (
    `Unknown notebook anchor "${wanted}": nothing in notebook.md resolves to it, so this ` +
    `block would point at nothing. Anchors that do exist: ${shown.join(", ")}${tail}. ` +
    `Record against one of those, or add {#${wanted}} to the step you mean first.`
  );
}

/** Thrown by the record tools' write path when the anchor stops resolving. */
export class UnknownAnchorError extends Error {
  constructor(input: string, anchors: string[]) {
    super(unknownAnchorMessage(input, anchors));
    this.name = "UnknownAnchorError";
  }
}
