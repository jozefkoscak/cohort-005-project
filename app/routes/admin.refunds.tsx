import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { requireUserId } from "~/lib/access.server";
import { parseFormData } from "~/lib/validation";
import { calendarDay, refundFeeCents } from "~/lib/refunds";
import { formatPrice } from "~/lib/utils";
import {
  UserRole,
  RefundStatus,
  comments,
  coupons,
  courseRatings,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAnswers,
  quizAttempts,
  quizzes,
  refunds,
  users,
  videoWatchEvents,
} from "~/db/schema";
import { db } from "~/db";
import { alias } from "drizzle-orm/sqlite-core";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, ReceiptText } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";

const refundDecisionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineReason: z
      .string()
      .trim()
      .min(10, "Tell the learner why, in at least a sentence.")
      .max(1000, "Please keep the reason under 1000 characters."),
  }),
]);

const refundViewSchema = z.enum(["open", "decided"]).catch("open");
type RefundView = z.infer<typeof refundViewSchema>;

async function requireAdmin(request: Request) {
  const userId = await requireUserId(request);
  const user = db.select().from(users).where(eq(users.id, userId)).get();

  if (!user || user.role !== UserRole.Admin) {
    throw data("Only admins can review refund requests.", { status: 403 });
  }

  return user;
}

const decidingAdmins = alias(users, "deciding_admins");

function selectRefundRequests() {
  return db
    .select({
      id: refunds.id,
      purchaseId: purchases.id,
      status: refunds.status,
      reason: refunds.reason,
      declineReason: refunds.declineReason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      amountRefunded: refunds.amountRefunded,
      decidedByName: decidingAdmins.name,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(decidingAdmins, eq(refunds.resolvedByUserId, decidingAdmins.id))
    .$dynamic();
}

function getCourseLessonIds(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getWatchedSeconds(userId: number, lessonIds: number[]): number {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

function daysBetween(fromIso: string, to: Date): number {
  const from = new Date(calendarDay(new Date(fromIso)));
  const until = new Date(calendarDay(to));
  return Math.round((until.getTime() - from.getTime()) / 86_400_000);
}

function getOpenRefundRequests() {
  const today = new Date();

  return selectRefundRequests()
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(asc(refunds.requestedAt))
    .all()
    .map((row) => ({
      ...row,
      daysSincePurchase: daysBetween(row.purchasedAt, today),
      watchedHours:
        getWatchedSeconds(row.learnerId, getCourseLessonIds(row.courseId)) /
        3600,
      refundFee: refundFeeCents(row.amountPaid),
    }));
}

function getDecidedRefundRequests() {
  return selectRefundRequests()
    .where(ne(refunds.status, RefundStatus.Open))
    .orderBy(desc(refunds.resolvedAt))
    .all();
}

function getOpenRefundRequest(refundRequestId: number) {
  const row = selectRefundRequests()
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!row) {
    throw data("Refund request not found.", { status: 404 });
  }

  if (row.status !== RefundStatus.Open) {
    throw data("This refund request has already been decided.", {
      status: 409,
    });
  }

  return row;
}

type OpenRefundRequest = ReturnType<typeof getOpenRefundRequest>;

function throwAlreadyDecided(): never {
  throw data("This refund request has already been decided.", {
    status: 409,
  });
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** See docs/adr/0001-approved-refund-erases-learner-history.md. */
function eraseLearnerFromCourse(
  tx: Transaction,
  learnerId: number,
  courseId: number
) {
  const lessonIds = getCourseLessonIds(courseId);

  if (lessonIds.length > 0) {
    const quizIds = tx
      .select({ id: quizzes.id })
      .from(quizzes)
      .where(inArray(quizzes.lessonId, lessonIds))
      .all()
      .map((row) => row.id);

    if (quizIds.length > 0) {
      const attemptIds = tx
        .select({ id: quizAttempts.id })
        .from(quizAttempts)
        .where(
          and(
            eq(quizAttempts.userId, learnerId),
            inArray(quizAttempts.quizId, quizIds)
          )
        )
        .all()
        .map((row) => row.id);

      if (attemptIds.length > 0) {
        tx.delete(quizAnswers)
          .where(inArray(quizAnswers.attemptId, attemptIds))
          .run();
        tx.delete(quizAttempts)
          .where(inArray(quizAttempts.id, attemptIds))
          .run();
      }
    }

    tx.delete(lessonProgress)
      .where(
        and(
          eq(lessonProgress.userId, learnerId),
          inArray(lessonProgress.lessonId, lessonIds)
        )
      )
      .run();

    tx.delete(videoWatchEvents)
      .where(
        and(
          eq(videoWatchEvents.userId, learnerId),
          inArray(videoWatchEvents.lessonId, lessonIds)
        )
      )
      .run();

    // Soft delete keeps other people's replies to the learner readable.
    tx.update(comments)
      .set({ deletedAt: new Date().toISOString() })
      .where(
        and(
          eq(comments.userId, learnerId),
          inArray(comments.lessonId, lessonIds),
          isNull(comments.deletedAt)
        )
      )
      .run();
  }

  tx.delete(courseRatings)
    .where(
      and(
        eq(courseRatings.userId, learnerId),
        eq(courseRatings.courseId, courseId)
      )
    )
    .run();

  tx.delete(enrollments)
    .where(
      and(eq(enrollments.userId, learnerId), eq(enrollments.courseId, courseId))
    )
    .run();
}

function approveRefundRequest(
  refundRequest: OpenRefundRequest,
  adminId: number
) {
  db.transaction((tx) => {
    const decided = tx
      .update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: refundRequest.amountPaid,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: adminId,
      })
      .where(
        and(
          eq(refunds.id, refundRequest.id),
          eq(refunds.status, RefundStatus.Open)
        )
      )
      .run();

    if (decided.changes === 0) throwAlreadyDecided();

    tx.delete(coupons)
      .where(
        and(
          eq(coupons.purchaseId, refundRequest.purchaseId),
          isNull(coupons.redeemedAt)
        )
      )
      .run();

    eraseLearnerFromCourse(tx, refundRequest.learnerId, refundRequest.courseId);
  });
}

function declineRefundRequest(
  refundRequest: OpenRefundRequest,
  adminId: number,
  declineReason: string
) {
  const decided = db
    .update(refunds)
    .set({
      status: RefundStatus.Declined,
      declineReason,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: adminId,
    })
    .where(
      and(
        eq(refunds.id, refundRequest.id),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .run();

  if (decided.changes === 0) throwAlreadyDecided();
}

/**
 * The learner hears the outcome by email. There is no mail transport wired up
 * yet, so the built message goes to the server log.
 */
function buildRefundDecisionEmail(
  refundRequest: OpenRefundRequest,
  decision: { intent: "approve" } | { intent: "decline"; declineReason: string }
) {
  const outcome =
    decision.intent === "approve"
      ? [
          `We approved your refund request for "${refundRequest.courseTitle}".`,
          `${formatPrice(refundRequest.amountPaid)} is on its way back to you.`,
          "",
          "You no longer have access to the course, and your progress, quiz results, rating and comments in it have been deleted.",
        ]
      : [
          `We declined your refund request for "${refundRequest.courseTitle}".`,
          "",
          decision.declineReason,
          "",
          "Your access to the course is back, and you can pick up where you left off.",
        ];

  return {
    to: refundRequest.learnerEmail,
    subject: `Refund ${decision.intent === "approve" ? "approved" : "declined"} — ${refundRequest.courseTitle}`,
    body: [
      `Hi ${refundRequest.learnerName},`,
      "",
      ...outcome,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Review learners' refund requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const view = refundViewSchema.parse(
    new URL(request.url).searchParams.get("view")
  );

  return {
    view,
    openRefundRequests: view === "open" ? getOpenRefundRequests() : [],
    decidedRefundRequests: view === "decided" ? getDecidedRefundRequests() : [],
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const parsed = parseFormData(await request.formData(), refundDecisionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors, decision: null }, { status: 400 });
  }

  const decision = parsed.data;
  const refundRequest = getOpenRefundRequest(decision.refundRequestId);

  if (decision.intent === "approve") {
    approveRefundRequest(refundRequest, admin.id);
  } else {
    declineRefundRequest(refundRequest, admin.id, decision.declineReason);
  }

  const email = buildRefundDecisionEmail(refundRequest, decision);
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { errors: null, decision: decision.intent };
}

// A card unmounts once its request is decided, so the page shares this fetcher
// key to announce the outcome.
const REFUND_DECISION_FETCHER_KEY = "refund-decision";

function useRefundDecisionToast() {
  const fetcher = useFetcher<typeof action>({
    key: REFUND_DECISION_FETCHER_KEY,
  });

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    const firstError = Object.values(fetcher.data.errors ?? {})[0];
    if (firstError) {
      toast.error(firstError);
    } else if (fetcher.data.decision) {
      toast.success(
        fetcher.data.decision === "approve"
          ? "Refund approved."
          : "Refund request declined."
      );
    }
  }, [fetcher.state, fetcher.data]);
}

type OpenRefundRequestRow =
  Route.ComponentProps["loaderData"]["openRefundRequests"][number];

function OpenRefundRequestCard({
  refundRequest,
}: {
  refundRequest: OpenRefundRequestRow;
}) {
  const fetcher = useFetcher<typeof action>({
    key: REFUND_DECISION_FETCHER_KEY,
  });
  const [isDeclining, setIsDeclining] = useState(false);
  const isSubmitting = fetcher.state !== "idle";

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <RefundRequestHeading refundRequest={refundRequest} />
        <p className="text-sm text-muted-foreground">
          Paid {formatPrice(refundRequest.amountPaid)} on{" "}
          {new Date(refundRequest.purchasedAt).toLocaleDateString()} ·{" "}
          {refundRequest.daysSincePurchase} days ago · watched{" "}
          {refundRequest.watchedHours.toFixed(1)} h · raised{" "}
          {new Date(refundRequest.requestedAt).toLocaleDateString()}
        </p>
        <p className="text-sm">{refundRequest.reason}</p>
        <p className="text-xs text-muted-foreground">
          Approving refunds {formatPrice(refundRequest.amountPaid)}, charges the
          instructor a {formatPrice(refundRequest.refundFee)} Refund Fee and
          deletes the learner's history in the course. It can't be undone.
        </p>
        <fetcher.Form method="post" className="space-y-2">
          <input
            type="hidden"
            name="refundRequestId"
            value={refundRequest.id}
          />
          {isDeclining && (
            <Textarea
              name="declineReason"
              rows={3}
              required
              placeholder="Why are we declining? The learner will read this."
            />
          )}
          <div className="flex gap-2">
            {isDeclining ? (
              <>
                <Button
                  type="submit"
                  name="intent"
                  value="decline"
                  size="sm"
                  disabled={isSubmitting}
                >
                  Decline
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsDeclining(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="submit"
                  name="intent"
                  value="approve"
                  size="sm"
                  disabled={isSubmitting}
                >
                  Approve and refund {formatPrice(refundRequest.amountPaid)}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => setIsDeclining(true)}
                >
                  Decline…
                </Button>
              </>
            )}
          </div>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

type DecidedRefundRequestRow =
  Route.ComponentProps["loaderData"]["decidedRefundRequests"][number];

function DecidedRefundRequestCard({
  refundRequest,
}: {
  refundRequest: DecidedRefundRequestRow;
}) {
  const approved = refundRequest.status === RefundStatus.Approved;

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <RefundRequestHeading refundRequest={refundRequest} />
        <p className="text-sm text-muted-foreground">
          {approved
            ? `Approved, refunded ${formatPrice(refundRequest.amountRefunded ?? refundRequest.amountPaid)}`
            : "Declined"}{" "}
          by {refundRequest.decidedByName ?? "an Admin"}
          {refundRequest.resolvedAt &&
            ` on ${new Date(refundRequest.resolvedAt).toLocaleDateString()}`}
        </p>
        <p className="text-sm">{refundRequest.reason}</p>
        {refundRequest.declineReason && (
          <p className="text-sm text-muted-foreground">
            Our reason: {refundRequest.declineReason}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RefundRequestHeading({
  refundRequest,
}: {
  refundRequest: {
    courseSlug: string;
    courseTitle: string;
    learnerName: string;
    learnerEmail: string;
  };
}) {
  return (
    <div>
      <Link
        to={`/courses/${refundRequest.courseSlug}`}
        className="font-medium hover:underline"
      >
        {refundRequest.courseTitle}
      </Link>
      <p className="text-sm text-muted-foreground">
        {refundRequest.learnerName} ({refundRequest.learnerEmail})
      </p>
    </div>
  );
}

function RefundViewLink({
  view,
  current,
  label,
}: {
  view: RefundView;
  current: RefundView;
  label: string;
}) {
  return (
    <Link to={`?view=${view}`}>
      <Button variant={view === current ? "default" : "outline"} size="sm">
        {label}
      </Button>
    </Link>
  );
}

function EmptyRefundRequests({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="py-8 text-center">
        <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
        <p className="text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { view, openRefundRequests, decidedRefundRequests } = loaderData;
  useRefundDecisionToast();

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          The learner's access is suspended until you decide. Decisions are
          final.
        </p>
      </div>

      <div className="mb-6 flex gap-2">
        <RefundViewLink view="open" current={view} label="Open" />
        <RefundViewLink view="decided" current={view} label="Decided" />
      </div>

      {view === "open" ? (
        openRefundRequests.length === 0 ? (
          <EmptyRefundRequests message="No refund requests are waiting." />
        ) : (
          <div className="space-y-4">
            {openRefundRequests.map((refundRequest) => (
              <OpenRefundRequestCard
                key={refundRequest.id}
                refundRequest={refundRequest}
              />
            ))}
          </div>
        )
      ) : decidedRefundRequests.length === 0 ? (
        <EmptyRefundRequests message="No refund requests have been decided yet." />
      ) : (
        <div className="space-y-4">
          {decidedRefundRequests.map((refundRequest) => (
            <DecidedRefundRequestCard
              key={refundRequest.id}
              refundRequest={refundRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const title = isRouteErrorResponse(error)
    ? `Error ${error.status}`
    : "Something went wrong";
  const message =
    isRouteErrorResponse(error) && typeof error.data === "string"
      ? error.data
      : "An unexpected error occurred while loading refund requests.";

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/admin/refunds">
          <Button>Back to refund requests</Button>
        </Link>
      </div>
    </div>
  );
}
