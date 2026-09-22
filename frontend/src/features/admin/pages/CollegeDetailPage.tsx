import { ExternalLink, Loader2, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AddressCascade, type AddressValue } from '@/features/admin/components/AddressCascade';
import { ProgramDialog } from '@/features/admin/components/ProgramDialog';
import { ProgramTable } from '@/features/admin/components/ProgramTable';
import { useCollege, useDeleteCollege, useUpdateCollege } from '@/features/admin/hooks/useCatalog';
import { isGoogleMapsUrl } from '@/lib/googleMaps';
import { paths } from '@/routes/paths';
import { ApiRequestError } from '@/types/api';
import type { College } from '@/types/catalog';

/**
 * One college, its programs, and where each program leads (FULLPLAN §57, Phase 2).
 *
 * The whole §57 Phase 2 demo happens on this screen except for the careers themselves:
 * programs are added under the college, given a recommended strand, and mapped to careers.
 *
 * ## The programs are a table, and the editor floats (2026-09-21)
 *
 * They were a paginated stack of cards, each with its own career-mapping picker inline. See
 * `ProgramTable` for why that shape stopped working, and `ProgramDialog` for where the mapping
 * went. What matters here is the state this page now keeps: **an id, not a program**. The dialog
 * re-reads its row out of the college on every render, so attaching a career — which invalidates
 * the college query — updates the open dialog instead of leaving it showing the snapshot it was
 * opened with.
 */
export function CollegeDetailPage() {
  const { collegeId = '' } = useParams();
  const navigate = useNavigate();

  const { data: college, isPending, isError, error } = useCollege(collegeId);

  const updateCollege = useUpdateCollege(collegeId);
  const deleteCollege = useDeleteCollege();

  const [isAddingProgram, setIsAddingProgram] = useState(false);
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null);

  if (isPending) {
    return (
      <div className="flex justify-center py-12" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Loading college…</span>
      </div>
    );
  }

  if (isError) {
    return <Alert>{error.message}</Alert>;
  }

  const programs = college.programs ?? [];
  const isArchived = college.status === 'archived';
  // Looked up rather than stored — see the note above. `null` also covers a program archived from
  // another tab and gone from the list: the dialog closes itself rather than editing a ghost.
  const editingProgram = programs.find((program) => program.id === editingProgramId) ?? null;

  function closeEditor() {
    setIsAddingProgram(false);
    setEditingProgramId(null);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* "All colleges" used to sit here; the shell's back control (AppShell) now stands one step
          above every page, and two of them on one screen is one too many. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-foreground">{college.name}</h1>
            <Badge tone={isArchived ? 'neutral' : 'success'}>{college.status}</Badge>
          </div>
          {college.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{college.description}</p>
          ) : null}
        </div>

        {/*
          `shrink-0` and a wrapping header above it: at 320px a name like "Bohol Island State
          University — Calape Campus" and two buttons cannot share a row, and the flex default was
          to squeeze the buttons rather than to stack.
        */}
        <div className="flex shrink-0 gap-2">
          {/*
            Archiving is the intended way to retire a college (§8) — the row and everything
            pointing at it survives, so a recommendation a student has already seen never
            dangles. Deleting is the harsher, rarer act, and is worded as such.
          */}
          <Button
            variant="secondary"
            loading={updateCollege.isPending}
            onClick={() => updateCollege.mutate({ status: isArchived ? 'active' : 'archived' })}
          >
            {isArchived ? 'Restore' : 'Archive'}
          </Button>

          <Button
            variant="ghost"
            loading={deleteCollege.isPending}
            onClick={() => {
              if (
                !window.confirm(
                  `Remove ${college.name} from the catalog? Its programs go with it. If you only want to stop recommending it, archive it instead.`,
                )
              ) {
                return;
              }

              deleteCollege.mutate(collegeId, {
                onSuccess: () => void navigate(paths.adminColleges),
              });
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </Button>
        </div>
      </div>

      <CollegeLocation collegeId={collegeId} college={college} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">
          Programs
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {programs.length === 0
              ? 'none yet'
              : `${programs.length} ${programs.length === 1 ? 'program' : 'programs'}`}
          </span>
        </h2>

        <Button size="sm" onClick={() => setIsAddingProgram(true)}>
          <Plus className="size-4" aria-hidden="true" />
          Add program
        </Button>
      </div>

      {programs.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No programs yet</CardTitle>
            <CardDescription>
              Add the programs this college offers. Each one can be linked to the careers it
              leads to — that mapping is what lets a student be matched to it.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ProgramTable
          collegeId={collegeId}
          programs={programs}
          onEdit={(program) => setEditingProgramId(program.id)}
        />
      )}

      <ProgramDialog
        collegeId={collegeId}
        program={editingProgram}
        open={isAddingProgram || editingProgram !== null}
        onClose={closeEditor}
      />
    </div>
  );
}

/**
 * The school's location (backend migration 0012): the address as a readable trail, a "View on
 * Google Maps" button when a link is on file, and an inline editor behind an "Edit" toggle.
 *
 * Editing is add-then-save on the whole address at once (the cascade clears children when a parent
 * changes), matching how the server takes it — a partial address update would orphan a level.
 */
function CollegeLocation({ collegeId, college }: { collegeId: string; college: College }) {
  const updateCollege = useUpdateCollege(collegeId);
  const [isEditing, setIsEditing] = useState(false);
  const [address, setAddress] = useState<AddressValue>(() => toAddressValue(college));
  const [mapLink, setMapLink] = useState(college.map_link ?? '');

  const serverError =
    updateCollege.error instanceof ApiRequestError ? updateCollege.error : null;
  const mapInvalid = mapLink.trim().length > 0 && !isGoogleMapsUrl(mapLink.trim());

  const trail = [college.region, college.province, college.town, college.barangay]
    .filter((place): place is { id: string; name: string } => place !== null)
    .map((place) => place.name);

  function startEditing() {
    setAddress(toAddressValue(college));
    setMapLink(college.map_link ?? '');
    setIsEditing(true);
  }

  function save() {
    if (mapInvalid) return;

    updateCollege.mutate(
      {
        region_id: address.region_id,
        province_id: address.province_id,
        town_id: address.town_id,
        barangay_id: address.barangay_id,
        map_link: mapLink.trim() === '' ? null : mapLink.trim(),
      },
      { onSuccess: () => setIsEditing(false) },
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="size-4 text-muted-foreground" aria-hidden="true" />
            Location
          </CardTitle>
          {!isEditing ? (
            <Button variant="ghost" size="sm" onClick={startEditing}>
              <Pencil className="size-4" aria-hidden="true" />
              Edit
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isEditing ? (
          <>
            <AddressCascade
              value={address}
              onChange={setAddress}
              errors={{
                region_id: serverError?.fieldError('region_id'),
                province_id: serverError?.fieldError('province_id'),
                town_id: serverError?.fieldError('town_id'),
                barangay_id: serverError?.fieldError('barangay_id'),
              }}
            />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-map-link">School map link</Label>
              <Input
                id="edit-map-link"
                value={mapLink}
                onChange={(event) => setMapLink(event.target.value)}
                placeholder="https://maps.app.goo.gl/…"
                aria-invalid={mapInvalid || Boolean(serverError?.fieldError('map_link'))}
              />
              {mapInvalid ? (
                <p className="text-sm text-destructive">
                  Enter a valid Google Maps link (e.g. https://maps.app.goo.gl/…).
                </p>
              ) : null}
              {serverError?.fieldError('map_link') ? (
                <p className="text-sm text-destructive">{serverError.fieldError('map_link')}</p>
              ) : null}
            </div>

            {serverError && Object.keys(serverError.errors).length === 0 ? (
              <Alert>{serverError.message}</Alert>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button onClick={save} loading={updateCollege.isPending} disabled={mapInvalid}>
                Save location
              </Button>
              <Button variant="secondary" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {trail.length > 0 ? trail.join(' › ') : 'No address on file.'}
            </p>

            {college.map_link ? (
              <a
                href={college.map_link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                <ExternalLink className="size-4" aria-hidden="true" />
                View on Google Maps
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">No map available.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The college's resolved places (id + name) as the cascade's null-able id value. */
function toAddressValue(college: College): AddressValue {
  return {
    region_id: college.region?.id ?? null,
    province_id: college.province?.id ?? null,
    town_id: college.town?.id ?? null,
    barangay_id: college.barangay?.id ?? null,
  };
}
