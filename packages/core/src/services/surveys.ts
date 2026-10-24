import { and, db, desc, eq, newId, segments, surveyResponses, surveys } from '@chorala/db'
import type {
  CreateSurveyInput,
  SubmitSurveyResponseInput,
  SurveyResults,
  UpdateSurveyInput,
} from '@chorala/types'
import { segmentDefinition } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { badRequest, notFound } from '../errors.ts'
import { getProject } from './projects.ts'
import { getSegment, isInSegment } from './segments.ts'

export async function listSurveys(ctx: AuthContext, projectId: string) {
  await getProject(ctx, projectId)
  return db
    .select()
    .from(surveys)
    .where(eq(surveys.projectId, projectId))
    .orderBy(desc(surveys.createdAt))
}

export async function getSurvey(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [row] = await db
    .select()
    .from(surveys)
    .where(and(eq(surveys.id, id), eq(surveys.projectId, projectId)))
  if (!row) throw notFound('Survey')
  return row
}

export async function createSurvey(ctx: AuthContext, projectId: string, input: CreateSurveyInput) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  if (input.segmentId) await getSegment(ctx, projectId, input.segmentId)
  const [row] = await db
    .insert(surveys)
    .values({
      id: newId('survey'),
      projectId,
      name: input.name,
      type: input.type,
      question: input.question,
      config: input.config,
      segmentId: input.segmentId ?? null,
      isActive: input.isActive,
    })
    .returning()
  if (!row) throw badRequest('Failed to create survey')
  return row
}

export async function updateSurvey(
  ctx: AuthContext,
  projectId: string,
  id: string,
  input: UpdateSurveyInput,
) {
  assertPermission(ctx, 'write')
  await getSurvey(ctx, projectId, id)
  if (input.segmentId) await getSegment(ctx, projectId, input.segmentId)
  const [row] = await db
    .update(surveys)
    .set({
      name: input.name,
      type: input.type,
      question: input.question,
      config: input.config,
      segmentId: input.segmentId === undefined ? undefined : input.segmentId,
      isActive: input.isActive,
    })
    .where(eq(surveys.id, id))
    .returning()
  return row
}

export async function deleteSurvey(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getSurvey(ctx, projectId, id)
  await db.delete(surveys).where(eq(surveys.id, id))
  return { id, deleted: true }
}

/** Aggregate a survey's responses into NPS / CSAT / distribution / text. */
export async function getResults(
  ctx: AuthContext,
  projectId: string,
  id: string,
): Promise<SurveyResults> {
  const survey = await getSurvey(ctx, projectId, id)
  const rows = await db
    .select({
      value: surveyResponses.value,
      text: surveyResponses.text,
      choice: surveyResponses.choice,
    })
    .from(surveyResponses)
    .where(eq(surveyResponses.surveyId, id))

  const values = rows.map((r) => r.value).filter((v): v is number => typeof v === 'number')
  const distribution: Record<string, number> = {}
  for (const v of values) distribution[v] = (distribution[v] ?? 0) + 1
  const choices: Record<string, number> = {}
  for (const r of rows) if (r.choice) choices[r.choice] = (choices[r.choice] ?? 0) + 1
  const texts = rows.map((r) => r.text).filter((t): t is string => !!t)

  let nps: number | null = null
  if (survey.type === 'nps' && values.length) {
    const promoters = values.filter((v) => v >= 9).length
    const detractors = values.filter((v) => v <= 6).length
    nps = Math.round(((promoters - detractors) / values.length) * 100)
  }
  let csatPercent: number | null = null
  if (
    (survey.type === 'csat' || survey.type === 'rating' || survey.type === 'ces') &&
    values.length
  ) {
    const cfg = survey.config as { scaleMax?: number }
    const max = cfg.scaleMax ?? 5
    const topBox = values.filter((v) => v >= max - 1).length // top-2-box
    csatPercent = Math.round((topBox / values.length) * 100)
  }
  const average = values.length
    ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100
    : null

  return { responseCount: rows.length, average, nps, csatPercent, distribution, choices, texts }
}

// ---- public ----

/** The active survey to show this end-user: matches the segment + not already answered. */
export async function getActiveSurvey(projectId: string, endUserId: string | undefined) {
  const active = await db
    .select()
    .from(surveys)
    .where(and(eq(surveys.projectId, projectId), eq(surveys.isActive, true)))
    .orderBy(desc(surveys.createdAt))

  for (const s of active) {
    if (endUserId) {
      const [answered] = await db
        .select({ id: surveyResponses.id })
        .from(surveyResponses)
        .where(and(eq(surveyResponses.surveyId, s.id), eq(surveyResponses.endUserId, endUserId)))
      if (answered) continue
      if (s.segmentId) {
        const [seg] = await db.select().from(segments).where(eq(segments.id, s.segmentId))
        if (
          seg &&
          !(await isInSegment(projectId, segmentDefinition.parse(seg.definition), endUserId))
        )
          continue
      }
    } else if (s.segmentId) {
      continue // targeted survey needs an identified user
    }
    return s
  }
  return null
}

export async function submitResponse(
  projectId: string,
  surveyId: string,
  endUserId: string,
  input: SubmitSurveyResponseInput,
) {
  const [s] = await db
    .select({ id: surveys.id })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.projectId, projectId)))
  if (!s) throw notFound('Survey')
  if (input.value === undefined && !input.text && !input.choice) {
    throw badRequest('A response is required')
  }
  await db
    .insert(surveyResponses)
    .values({
      id: newId('surveyResponse'),
      surveyId,
      endUserId,
      value: input.value,
      text: input.text,
      choice: input.choice,
    })
    .onConflictDoNothing() // one response per user (unique index)
  return { recorded: true }
}
