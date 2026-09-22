import { CareerLinkEditor } from '@/features/admin/components/CareerLinkEditor';
import {
  useAttachCanonicalCareer,
  useDetachCanonicalCareer,
  useSetCanonicalCareerRelationship,
} from '@/features/admin/hooks/useCatalog';
import type { CanonicalProgram } from '@/types/catalog';

/**
 * What a canonical program leads to (backend migration 0040) — **the** place a program's careers
 * are edited.
 *
 * One link here is one link on every college offering of the program, and it is what §27 ranks
 * every one of those offerings on. Before 0040 the same change was made campus by campus on each
 * college page, and a missed campus scored differently from its twins for no reason a student could
 * see. The college page still takes extras for a single campus; this is the degree's own list.
 */
export function CanonicalCareerMapping({ entry }: { entry: CanonicalProgram }) {
  const attach = useAttachCanonicalCareer();
  const detach = useDetachCanonicalCareer();
  const setRelationship = useSetCanonicalCareerRelationship();

  const offerings = entry.offerings_count ?? 0;

  return (
    <CareerLinkEditor
      inputId={`link-canonical-career-${entry.id}`}
      targetLabel={entry.code}
      heading="Careers this program leads to"
      linked={entry.careers ?? []}
      emptyText="Not linked to any career yet — until it is, no college offering of it can be matched to a student's RIASEC profile."
      onAttach={(careerId, relationship, onDone) =>
        attach.mutate({ id: entry.id, careerId, relationship }, { onSuccess: onDone })
      }
      onChangeRelationship={(career, relationship, onDone) =>
        setRelationship.mutate(
          { id: entry.id, careerId: career.id, relationship },
          { onSuccess: onDone },
        )
      }
      isChangingRelationship={setRelationship.isPending}
      onDetach={(careerId) => detach.mutate({ id: entry.id, careerId })}
      isAttaching={attach.isPending}
      isDetaching={detach.isPending}
      error={attach.error ?? detach.error ?? setRelationship.error}
      note={
        offerings === 0
          ? 'No college offers this yet — links here apply to every offering added later.'
          : `Applies to all ${offerings} college ${offerings === 1 ? 'offering' : 'offerings'}. Students see the change the next time their recommendations are generated.`
      }
    />
  );
}
