import { ArrowLeft, ExternalLink, Loader2, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AddressCascade, type AddressValue } from '@/features/admin/components/AddressCascade';
import { CareerMapping } from '@/features/admin/components/CareerMapping';
import { ProgramForm } from '@/features/admin/components/ProgramForm';
import {
  useCollege,
  useDeleteCollege,
  useDeleteProgram,
  useUpdateCollege,
} from '@/features/admin/hooks/useCatalog';
import { isGoogleMapsUrl } from '@/lib/googleMaps';
import { paths } from '@/routes/paths';
import { ApiRequestError } from '@/types/api';
import type { College, Program, ProgramStatus } from '@/types/catalog';

/**
 * One college, its programs, and where each program leads (FULLPLAN §57, Phase 2).
 *
 * The whole §57 Phase 2 demo happens on this screen except for the careers themselves:
 * programs are added under the college, given a recommended strand, and mapped to careers.
 */
export function CollegeDetailPage() {
  const { collegeId = '' } = useParams();
  const navigate = useNavigate();

  const { data: college, isPending, isError, error } = useCollege(collegeId);

  const updateCollege = useUpdateCollege(collegeId);
  const deleteCollege = useDeleteCollege();
  const deleteProgram = useDeleteProgram(collegeId);

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

  return (
    <div className="flex flex-col gap-6">
      <Link
        to={paths.adminColleges}
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All colleges
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-foreground">{college.name}</h1>
            <Badge tone={isArchived ? 'neutral' : 'success'}>{college.status}</Badge>
          </div>
          {college.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{college.description}</p>
          ) : null}
        </div>

        <div className="flex gap-2">
          {/*
            Archiving is the intended way to retire a college (§8) — the row and everything
            pointing at it survives, so a recommendation a student has already seen never
            dangles. Deleting is the harsher, rarer act, and is worded as such.
          */}
          <Button
            variant="secondary"
            loading={updateCollege.isPending}
            onClick={() =>
              updateCollege.mutate({ status: isArchived ? 'active' : 'archived' })
            }
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

      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-foreground">
          Programs
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {programs.length === 0
              ? 'none yet'
              : `${programs.length} ${programs.length === 1 ? 'program' : 'programs'}`}
          </span>
        </h2>

        {!isAddingProgram ? (
          <Button size="sm" onClick={() => setIsAddingProgram(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add program
          </Button>
        ) : null}
      </div>

      {isAddingProgram ? (
        <ProgramForm
          collegeId={collegeId}
          onSaved={() => setIsAddingProgram(false)}
          onCancel={() => setIsAddingProgram(false)}
        />
      ) : null}

      {programs.length === 0 && !isAddingProgram ? (
        <Card>
          <CardHeader>
            <CardTitle>No programs yet</CardTitle>
            <CardDescription>
              Add the programs this college offers. Each one can be linked to the careers it
              leads to — that mapping is what lets a student be matched to it.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <ul className="flex flex-col gap-4">
        {programs.map((program) =>
          editingProgramId === program.id ? (
            <li key={program.id}>
              <ProgramForm
                collegeId={collegeId}
                program={program}
                onSaved={() => setEditingProgramId(null)}
                onCancel={() => setEditingProgramId(null)}
              />
            </li>
          ) : (
            <li key={program.id}>
              <ProgramCard
                collegeId={collegeId}
                program={program}
                onEdit={() => setEditingProgramId(program.id)}
                onDelete={() => {
                  if (!window.confirm(`Remove ${program.code} — ${program.name}?`)) return;

                  deleteProgram.mutate(program.id);
                }}
              />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

interface ProgramCardProps {
  collegeId: string;
  program: Program;
  onEdit: () => void;
  onDelete: () => void;
}

function ProgramCard({ collegeId, program, onEdit, onDelete }: ProgramCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>
              <span className="font-mono text-sm tracking-wide text-muted-foreground">{program.code}</span>
              <span className="ml-2">{program.name}</span>
            </CardTitle>
            <CardDescription>
              {program.department_name ?? 'No department'}
              {' · '}
              {/*
                Null is not a gap here — it is a claim. §27 scores a program with no strand
                requirement as a full 100 for every student, so "Open to any strand" is the
                accurate reading, not "Unknown".
              */}
              {program.recommended_strand ?? 'Open to any strand'}
            </CardDescription>
          </div>

          <div className="flex items-center gap-2">
            <Badge tone={programStatusTone(program.status)}>{program.status}</Badge>

            <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${program.code}`}>
              <Pencil className="size-4" aria-hidden="true" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              aria-label={`Delete ${program.code}`}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <CareerMapping collegeId={collegeId} program={program} />
      </CardContent>
    </Card>
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

            <div className="flex gap-2">
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

/**
 * Only an active program is ever recommended (§27) — status is the difference between a
 * program students can be matched to and one that merely exists.
 */
function programStatusTone(status: ProgramStatus): 'success' | 'warning' | 'neutral' {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'warning';
    case 'archived':
      return 'neutral';
  }
}
