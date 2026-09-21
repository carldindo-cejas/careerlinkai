import type { KnowledgeDocument, User } from '@/db/schema';
import { ApiError } from '@/lib/envelope';

/**
 * Knowledge authorization — the fine layer of the two-level model (FULLPLAN §39).
 *
 * `ensureRole('admin', 'counselor')` is the coarse gate and answers "may this *kind* of user touch
 * the knowledge base at all". This answers "may this user touch *this* entry", which a middleware
 * cannot: it has to see the record.
 *
 * Plain functions, not a class — a policy has no state and nothing to inject (§39, v1.3).
 *
 * ## The rule, and the distinction it rests on
 *
 * A counselor is a **global contributor**: what they write enters the one shared corpus and is
 * retrievable by every student in the school, exactly like an admin's entry. There is no
 * per-counselor retrieval scope, and this policy does not create one — `KNOWLEDGE_VISIBILITIES`
 * still has `COUNSELOR_PRIVATE` deferred to §63 for the reason recorded there (it shipped once
 * with no retrieval-scoping rule and was a cross-tenant leak waiting to happen).
 *
 * What is scoped is **custody**, not reach. A counselor manages the entries they authored and sees
 * only those in their library; an admin sees and manages everything. Two different questions that
 * are easy to conflate:
 *
 *   * *Who can this answer reach?*   Everyone. Always. That is the point of contributing.
 *   * *Whose entry is it to edit?*   The person who wrote it, and any admin.
 *
 * Keeping them separate is what lets counselors contribute without any of them acquiring the
 * ability to quietly rewrite a colleague's — or the school's — published answer.
 */

/** An admin sees every entry; a counselor sees only the ones they authored. */
export function canViewKnowledge(user: User, document: KnowledgeDocument): boolean {
  return user.role === 'admin' || document.uploadedBy === user.id;
}

/**
 * Same rule for writes, with one subtraction: catalog entries are admin-only.
 *
 * A `catalog` entry is regenerated from `careers` / `programs` by the nightly sync, so editing one
 * is temporary by construction — the next change to the underlying record overwrites it. An admin
 * is told this on the edit form and can weigh it. A counselor has no access to the catalog screens
 * that would let them make the change permanent, so for them the edit is *only* the surprise:
 * saved, apparently applied, silently reverted some night later. Refusing is the honest answer.
 *
 * In practice a counselor never owns one anyway — the sync attributes its rows to an admin — so
 * this is belt-and-braces against a future sync that attributes differently.
 */
export function canManageKnowledge(user: User, document: KnowledgeDocument): boolean {
  if (user.role === 'admin') {
    return true;
  }

  return document.sourceType !== 'catalog' && document.uploadedBy === user.id;
}

/**
 * Throw unless the caller may read this entry.
 *
 * **404, not 403** (§19, `docs/api`), the same rule `ClassPolicy` applies: a 403 would confirm the
 * entry exists, which is a fact a counselor is not entitled to about a colleague's work. "Not
 * yours" and "not real" have to be indistinguishable from outside, or the status code becomes a
 * way to enumerate what other people have written.
 */
export function authorizeViewKnowledge(
  user: User,
  document: KnowledgeDocument,
): KnowledgeDocument {
  if (!canViewKnowledge(user, document)) {
    throw ApiError.notFound('Knowledge document not found.');
  }

  return document;
}

/**
 * Throw unless the caller may edit, archive or reprocess this entry.
 *
 * A counselor who can *see* an entry can always manage it (they authored it), so the only case
 * where these two diverge is the catalog entry an admin can edit and nobody else can see. That is
 * why this still answers 404 rather than 403: for a counselor the two refusals are the same
 * refusal, and splitting them would leak the distinction.
 */
export function authorizeManageKnowledge(
  user: User,
  document: KnowledgeDocument,
): KnowledgeDocument {
  if (!canManageKnowledge(user, document)) {
    throw ApiError.notFound('Knowledge document not found.');
  }

  return document;
}
