import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateTemplate } from '@/features/assessment-builder/hooks/useBuilder';
import { counselorAssessmentApi } from '@/services/assessmentApi';

/**
 * Assessment templates (Phase 5b — FULLPLAN §31, §35 `assessment-builder`).
 *
 * Shared by admin and counselor (the base path differs, the content does not): the list is
 * the same `/counselor/assessment-templates` read the assignment picker uses, so a counselor
 * sees the global instruments plus their own, and an admin sees everything.
 *
 * RIASEC and SCCT appear but do not open a builder: they are curated instruments (§5), and
 * `ai_generatable: false` is the server's word on it — the UI mirrors the rule it cannot
 * enforce.
 */
export function TemplateListPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const base = location.pathname.startsWith('/admin') ? '/admin' : '/counselor';

  const { data: templates, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['builder', 'templates'],
    queryFn: () => counselorAssessmentApi.listTemplates(),
  });

  const create = useCreateTemplate();
  const [title, setTitle] = useState('');

  async function handleCreate() {
    if (title.trim().length === 0) {
      return;
    }

    const template = await create.mutateAsync({ title: title.trim() });

    navigate(`${base}/assessment-templates/${template.id}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Assessment templates</h1>
        <p className="text-sm text-slate-500">
          Build CUSTOM assessments by hand or draft them with AI — every AI-proposed scoring
          mapping must be confirmed by a human before a version can publish.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New CUSTOM template</CardTitle>
          <CardDescription>
            RIASEC and SCCT are curated instruments and cannot be created or AI-edited — only
            CUSTOM templates are built here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-3">
          <div className="flex-1">
            <Label htmlFor="template-title">Title</Label>
            <Input
              id="template-title"
              value={title}
              placeholder="Study Habits Survey"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <Button disabled={create.isPending || title.trim().length === 0} onClick={() => void handleCreate()}>
            {create.isPending ? 'Creating…' : 'Create template'}
          </Button>
        </CardContent>
        {create.isError ? (
          <CardContent>
            <Alert>{create.error.message}</Alert>
          </CardContent>
        ) : null}
      </Card>

      {isLoading ? <p className="text-sm text-slate-500">Loading templates…</p> : null}

      {isError ? (
        <Alert>
          We could not load the template list. {error.message}{' '}
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </Alert>
      ) : null}

      {templates?.map((template) => (
        <Card key={template.id}>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                {template.title}
                <Badge>{template.category}</Badge>
                {template.ownership === 'COUNSELOR_PRIVATE' ? <Badge>Private</Badge> : null}
                {template.assignable_version === null ? (
                  <Badge>No published version</Badge>
                ) : (
                  <Badge tone="success">
                    v{template.assignable_version.version_number} published
                  </Badge>
                )}
              </CardTitle>
              {template.description ? (
                <CardDescription>{template.description}</CardDescription>
              ) : null}
            </div>

            {template.ai_generatable ? (
              <Button
                variant="secondary"
                onClick={() => navigate(`${base}/assessment-templates/${template.id}`)}
              >
                Open builder
              </Button>
            ) : (
              <p className="text-sm text-slate-400">Curated instrument</p>
            )}
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
