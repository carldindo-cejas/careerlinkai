import { and, count, countDistinct, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '@/db/client';
import {
  aiRequests,
  assessmentAssignments,
  assessmentAttempts,
  assessmentVersions,
  auditLogs,
  careers,
  classStudents,
  classes,
  colleges,
  knowledgeDocuments,
  notifications,
  programs,
  recommendations,
  studentProfiles,
  users,
  type User,
} from '@/db/schema';
import { academicAverage } from '@/lib/recommendation';
import { AuditService, type AuditLogView } from '@/modules/platform/audit-service';

/**
 * The three §20 dashboard endpoints' data (Phase 6), pulled live from the domain tables —
 * §54: "no dedicated analytics warehouse … they are pulled from `ai_requests`, `audit_logs`
 * and basic introspection directly."
 *
 * Every number here is a plain aggregate over live rows. Nothing is cached and nothing is
 * denormalized: at thesis scale the whole admin dashboard is ~a dozen indexed COUNTs, well
 * inside the Free plan's 50-subrequest envelope for one request (§45), and a cache would
 * only add a way for the demo to show yesterday.
 *
 * The payloads are returned in their API shape (snake_case) directly: these are computed
 * aggregates with no table row behind them, so a serializer would be the identity function.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function sevenDaysAgo(): string {
  return new Date(Date.now() - WEEK_MS).toISOString();
}

export interface AdminDashboard {
  totals: {
    students: number;
    counselors: number;
    classes: number;
    colleges: number;
    programs: number;
    careers: number;
    knowledge_documents: number;
  };
  assessments: {
    published_versions: number;
    attempts_in_progress: number;
    attempts_scored: number;
    completion_rate: number | null;
  };
  student_access_7d: {
    success: number;
    failed: number;
    throttled: number;
  };
  ai_7d: {
    requests: number;
    failed: number;
    tokens_used: number;
    avg_latency_ms: number | null;
  };
  recent_activity: AuditLogView[];
}

export interface CounselorDashboardClassRow {
  id: string;
  name: string;
  students_count: number;
  active_assignments: number;
  scored_attempts: number;
}

export interface CounselorDashboard {
  totals: {
    classes: number;
    students: number;
    active_assignments: number;
  };
  attempts: {
    in_progress: number;
    scored: number;
  };
  students_with_recommendations: number;
  classes: CounselorDashboardClassRow[];
}

export interface StudentDashboard {
  assignments: {
    active: number;
    completed: number;
    pending: number;
  };
  results_count: number;
  recommendations_ready: boolean;
  unread_notifications: number;
  profile_complete: boolean;
}

export class DashboardService {
  constructor(private readonly db: Database) {}

  async adminDashboard(): Promise<AdminDashboard> {
    const cutoff = sevenDaysAgo();

    const [
      roleCounts,
      [classCount],
      [collegeCount],
      [programCount],
      [careerCount],
      [knowledgeCount],
      [publishedCount],
      attemptCounts,
      accessCounts,
      [aiAggregate],
      recent,
    ] = await Promise.all([
      this.db
        .select({ role: users.role, value: count() })
        .from(users)
        .where(and(isNull(users.deletedAt), inArray(users.role, ['student', 'counselor'])))
        .groupBy(users.role),
      this.db.select({ value: count() }).from(classes).where(isNull(classes.deletedAt)),
      this.db.select({ value: count() }).from(colleges).where(isNull(colleges.deletedAt)),
      this.db.select({ value: count() }).from(programs).where(isNull(programs.deletedAt)),
      this.db.select({ value: count() }).from(careers).where(isNull(careers.deletedAt)),
      this.db
        .select({ value: count() })
        .from(knowledgeDocuments)
        .where(isNull(knowledgeDocuments.archivedAt)),
      this.db
        .select({ value: count() })
        .from(assessmentVersions)
        .where(eq(assessmentVersions.status, 'PUBLISHED')),
      this.db
        .select({ status: assessmentAttempts.status, value: count() })
        .from(assessmentAttempts)
        .groupBy(assessmentAttempts.status),
      this.db
        .select({ action: auditLogs.action, value: count() })
        .from(auditLogs)
        .where(
          and(
            inArray(auditLogs.action, [
              'STUDENT_CLASS_ACCESS_SUCCESS',
              'STUDENT_CLASS_ACCESS_FAILED',
              'STUDENT_CLASS_ACCESS_THROTTLED',
            ]),
            gte(auditLogs.createdAt, cutoff),
          ),
        )
        .groupBy(auditLogs.action),
      this.db
        .select({
          requests: count(),
          failed: sql<number>`SUM(CASE WHEN ${aiRequests.status} = 'FAILED' THEN 1 ELSE 0 END)`,
          tokens: sql<number>`COALESCE(SUM(${aiRequests.tokensUsed}), 0)`,
          avgLatency: sql<number | null>`AVG(${aiRequests.latencyMs})`,
        })
        .from(aiRequests)
        .where(gte(aiRequests.createdAt, cutoff)),
      new AuditService(this.db).list({ page: 1, perPage: 8 }),
    ]);

    const byRole = new Map(roleCounts.map((row) => [row.role, row.value]));
    const byStatus = new Map(attemptCounts.map((row) => [row.status, row.value]));
    const byAction = new Map(accessCounts.map((row) => [row.action, row.value]));

    const inProgress = byStatus.get('IN_PROGRESS') ?? 0;
    const submitted = byStatus.get('SUBMITTED') ?? 0;
    const scored = byStatus.get('SCORED') ?? 0;
    const started = inProgress + submitted + scored;

    return {
      totals: {
        students: byRole.get('student') ?? 0,
        counselors: byRole.get('counselor') ?? 0,
        classes: classCount?.value ?? 0,
        colleges: collegeCount?.value ?? 0,
        programs: programCount?.value ?? 0,
        careers: careerCount?.value ?? 0,
        knowledge_documents: knowledgeCount?.value ?? 0,
      },
      assessments: {
        published_versions: publishedCount?.value ?? 0,
        attempts_in_progress: inProgress,
        attempts_scored: scored,
        // §54's completion rate: scored over everything ever started (EXPIRED excluded — a
        // reset attempt was voided, not abandoned). NULL when nothing has started: 0% would
        // claim students are abandoning assessments nobody has been given.
        completion_rate: started === 0 ? null : Math.round((scored / started) * 1000) / 10,
      },
      student_access_7d: {
        success: byAction.get('STUDENT_CLASS_ACCESS_SUCCESS') ?? 0,
        failed: byAction.get('STUDENT_CLASS_ACCESS_FAILED') ?? 0,
        throttled: byAction.get('STUDENT_CLASS_ACCESS_THROTTLED') ?? 0,
      },
      ai_7d: {
        requests: aiAggregate?.requests ?? 0,
        failed: aiAggregate?.failed ?? 0,
        tokens_used: aiAggregate?.tokens ?? 0,
        avg_latency_ms:
          aiAggregate?.avgLatency === null || aiAggregate?.avgLatency === undefined
            ? null
            : Math.round(aiAggregate.avgLatency),
      },
      recent_activity: recent.items,
    };
  }

  /** Scoped exactly like `GET /counselor/classes`: a counselor sees theirs, an admin sees all. */
  async counselorDashboard(user: User): Promise<CounselorDashboard> {
    const classConditions = [isNull(classes.deletedAt)];

    if (user.role !== 'admin') {
      classConditions.push(eq(classes.counselorId, user.id));
    }

    const myClasses = await this.db
      .select({ id: classes.id, name: classes.name })
      .from(classes)
      .where(and(...classConditions))
      .orderBy(desc(classes.createdAt));

    const classIds = myClasses.map((row) => row.id);

    if (classIds.length === 0) {
      return {
        totals: { classes: 0, students: 0, active_assignments: 0 },
        attempts: { in_progress: 0, scored: 0 },
        students_with_recommendations: 0,
        classes: [],
      };
    }

    const [studentCounts, assignmentCounts, attemptCounts, [withRecommendations]] =
      await Promise.all([
        this.db
          .select({ classId: classStudents.classId, value: count() })
          .from(classStudents)
          .where(and(inArray(classStudents.classId, classIds), eq(classStudents.status, 'active')))
          .groupBy(classStudents.classId),
        this.db
          .select({ classId: assessmentAssignments.classId, value: count() })
          .from(assessmentAssignments)
          .where(
            and(
              inArray(assessmentAssignments.classId, classIds),
              eq(assessmentAssignments.status, 'ACTIVE'),
            ),
          )
          .groupBy(assessmentAssignments.classId),
        this.db
          .select({
            classId: assessmentAssignments.classId,
            status: assessmentAttempts.status,
            value: count(),
          })
          .from(assessmentAttempts)
          .innerJoin(
            assessmentAssignments,
            eq(assessmentAttempts.assignmentId, assessmentAssignments.id),
          )
          .where(inArray(assessmentAssignments.classId, classIds))
          .groupBy(assessmentAssignments.classId, assessmentAttempts.status),
        // "Students of mine who have a recommendation set" — the counselor's §4 signal that
        // the guidance conversation can start.
        this.db
          .select({ value: countDistinct(recommendations.studentId) })
          .from(recommendations)
          .innerJoin(classStudents, eq(classStudents.studentId, recommendations.studentId))
          .where(
            and(inArray(classStudents.classId, classIds), eq(classStudents.status, 'active')),
          ),
      ]);

    const studentsByClass = new Map(studentCounts.map((row) => [row.classId, row.value]));
    const assignmentsByClass = new Map(assignmentCounts.map((row) => [row.classId, row.value]));
    const scoredByClass = new Map<string, number>();

    let inProgress = 0;
    let scored = 0;

    for (const row of attemptCounts) {
      if (row.status === 'IN_PROGRESS') {
        inProgress += row.value;
      }

      if (row.status === 'SCORED') {
        scored += row.value;
        scoredByClass.set(row.classId, (scoredByClass.get(row.classId) ?? 0) + row.value);
      }
    }

    return {
      totals: {
        classes: classIds.length,
        students: [...studentsByClass.values()].reduce((sum, value) => sum + value, 0),
        active_assignments: [...assignmentsByClass.values()].reduce((sum, value) => sum + value, 0),
      },
      attempts: { in_progress: inProgress, scored },
      students_with_recommendations: withRecommendations?.value ?? 0,
      classes: myClasses.slice(0, 10).map((row) => ({
        id: row.id,
        name: row.name,
        students_count: studentsByClass.get(row.id) ?? 0,
        active_assignments: assignmentsByClass.get(row.id) ?? 0,
        scored_attempts: scoredByClass.get(row.id) ?? 0,
      })),
    };
  }

  async studentDashboard(user: User): Promise<StudentDashboard> {
    // Active assignments visible to this student: ACTIVE assignments in classes where their
    // enrollment is active and the class itself is live — the same visibility rule as
    // `GET /student/assignments`.
    const activeAssignments = await this.db
      .select({ id: assessmentAssignments.id })
      .from(assessmentAssignments)
      .innerJoin(classes, eq(assessmentAssignments.classId, classes.id))
      .innerJoin(classStudents, eq(classStudents.classId, classes.id))
      .where(
        and(
          eq(classStudents.studentId, user.id),
          eq(classStudents.status, 'active'),
          eq(assessmentAssignments.status, 'ACTIVE'),
          eq(classes.status, 'active'),
          isNull(classes.deletedAt),
        ),
      );

    const assignmentIds = activeAssignments.map((row) => row.id);

    const [attemptCounts, [recommendationCount], [unread], profile] = await Promise.all([
      this.db
        .select({ status: assessmentAttempts.status, value: count() })
        .from(assessmentAttempts)
        .where(eq(assessmentAttempts.studentId, user.id))
        .groupBy(assessmentAttempts.status),
      this.db
        .select({ value: count() })
        .from(recommendations)
        .where(eq(recommendations.studentId, user.id)),
      this.db
        .select({ value: count() })
        .from(notifications)
        .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt))),
      this.db.query.studentProfiles.findFirst({ where: eq(studentProfiles.userId, user.id) }),
    ]);

    // "Done" among the *active* assignments needs its own query — the grouped counts above
    // span closed assignments too (finished work survives its assignment closing, §21).
    const [doneActive] =
      assignmentIds.length === 0
        ? [{ value: 0 }]
        : await this.db
            .select({ value: count() })
            .from(assessmentAttempts)
            .where(
              and(
                eq(assessmentAttempts.studentId, user.id),
                inArray(assessmentAttempts.assignmentId, assignmentIds),
                inArray(assessmentAttempts.status, ['SUBMITTED', 'SCORED']),
              ),
            );

    const byStatus = new Map(attemptCounts.map((row) => [row.status, row.value]));
    const scored = byStatus.get('SCORED') ?? 0;

    return {
      assignments: {
        active: assignmentIds.length,
        completed: doneActive?.value ?? 0,
        pending: assignmentIds.length - (doneActive?.value ?? 0),
      },
      results_count: scored,
      recommendations_ready: (recommendationCount?.value ?? 0) > 0,
      unread_notifications: unread?.value ?? 0,
      // §27's two profile inputs with no in-engine fallback questionnaire: the strand, and an
      // academic signal — which since 2026-07-27 is the mean of the subject grades rather than
      // the removed GWA field. "Complete" here means "the recommendation engine has your real
      // signals, not neutrals", and one subject grade is enough for that to be true.
      profile_complete:
        profile?.shsStrandId != null &&
        academicAverage({
          mathGrade: profile.mathGrade,
          scienceGrade: profile.scienceGrade,
          englishGrade: profile.englishGrade,
        }) !== null,
    };
  }
}
