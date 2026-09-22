import { Link } from 'react-router-dom';

import { CareerLinkEditor } from '@/features/admin/components/CareerLinkEditor';
import {
  useAttachCareer,
  useDetachCareer,
  useSetCanonicalCareerRelationship,
  useSetCareerRelationship,
} from '@/features/admin/hooks/useCatalog';
import { paths } from '@/routes/paths';
import type { Program } from '@/types/catalog';

/**
 * One college offering's program <-> career mapping (FULLPLAN §57, §27).
 *
 * This is where a program stops being a name and becomes something the recommendation
 * engine can reason about: §27 averages the RIASEC compatibility of every career linked
 * to it to produce the program's own RIASEC score. A program with nothing linked falls back
 * to a neutral 50 — so an empty mapping is a scoring decision, not an empty field, and the
 * UI says so out loud rather than leaving a blank space.
 *
 * ## Two kinds of chip since backend migration 0040
 *
 * What a program leads to is linked **once, on its canonical program**, and every college offering
 * inherits it. Those chips are marked "from BSCS" and are added and removed on the Canonical programs
 * page — removing one here would silently make this campus score differently from its twins. What
 * this screen adds is a **college-specific extra**: a destination this campus's offering has on top
 * of the degree's own.
 *
 * Either kind can be **re-graded** here (direct / related / conditional). An extra is re-graded on
 * this offering; an inherited chip is re-graded on its canonical link, for every college at once,
 * and the grade picker says so before the admin saves.
 */
export interface CareerMappingProps {
  collegeId: string;
  program: Program;
}

export function CareerMapping({ collegeId, program }: CareerMappingProps) {
  const attachCareer = useAttachCareer(collegeId);
  const detachCareer = useDetachCareer(collegeId);
  const setRelationship = useSetCareerRelationship(collegeId);
  const setCanonicalRelationship = useSetCanonicalCareerRelationship();

  const linked = program.careers ?? [];
  const canonicalCode = program.canonical?.code ?? null;
  const hasInherited = linked.some((career) => career.inherited);

  return (
    <CareerLinkEditor
      inputId={`link-career-${program.id}`}
      targetLabel={program.code}
      heading="Careers this program leads to"
      linked={linked}
      emptyText="Not linked to any career yet — until it is, this program cannot be matched to a student's RIASEC profile."
      onAttach={(careerId, relationship, onDone) =>
        attachCareer.mutate(
          { programId: program.id, careerId, relationship },
          { onSuccess: onDone },
        )
      }
      onChangeRelationship={(career, relationship, onDone) => {
        // An inherited link lives on the canonical program; the offering endpoint would 422 it.
        if (career.inherited && program.program_catalog_id) {
          setCanonicalRelationship.mutate(
            { id: program.program_catalog_id, careerId: career.id, relationship },
            { onSuccess: onDone },
          );
          return;
        }

        setRelationship.mutate(
          { programId: program.id, careerId: career.id, relationship },
          { onSuccess: onDone },
        );
      }}
      isChangingRelationship={setRelationship.isPending || setCanonicalRelationship.isPending}
      inheritedEditNote={`This link comes from ${canonicalCode ?? 'its canonical program'}, so the new grade applies to every college that offers it.`}
      onDetach={(careerId) => detachCareer.mutate({ programId: program.id, careerId })}
      isAttaching={attachCareer.isPending}
      isDetaching={detachCareer.isPending}
      error={
        attachCareer.error ??
        detachCareer.error ??
        setRelationship.error ??
        setCanonicalRelationship.error
      }
      inheritedLabel={canonicalCode ? `from ${canonicalCode}` : 'inherited'}
      note={
        hasInherited ? (
          <>
            Careers marked <em>from {canonicalCode ?? 'its canonical program'}</em> apply to every
            college offering it — add or remove them on{' '}
            <Link to={paths.adminCanonicalPrograms} className="text-primary underline">
              Canonical programs
            </Link>
            . A career linked here is an extra for this college only.
          </>
        ) : null
      }
    />
  );
}
