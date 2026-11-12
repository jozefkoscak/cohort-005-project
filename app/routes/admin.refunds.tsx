import { useEffect } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { requireUserId } from "~/lib/access.server";
import { parseFormData } from "~/lib/validation";
import { getRefundableAmount } from "~/lib/refunds";
import { formatPrice } from "~/lib/utils";
import {
  UserRole,
  RefundStatus,
  courses,
  enrollments,
  purchases,
  refunds,
  users,
} from "~/db/schema";
import { db } from "~/db";
import { and, asc, eq } from "drizzle-orm";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { AlertTriangle, ReceiptText } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";

const refundDecisionSchema = z.object({
  intent: z.enum(["approve", "decline"]),
  refundRequestId: z.coerce.number().int(),
});

type RefundDecision = z.infer<typeof refundDecisionSchema>["intent"];

async function requireAdmin(request: Request) {
  const userId = await requireUserId(request);
  const user = db.select().from(users).where(eq(users.id, userId)).get();

  if (!user || user.role !== UserRole.Admin) {
    throw data("Only admins can review refund requests.", { status: 403 });
  }

  return user;
}

function selectRefundRequests() {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      learnerId: users.id,
      learnerName: users.name,
      learnerEmail: users.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      coursePrice: courses.price,
      amountPaid: purchases.amountPaid,
      country: purchases.country,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .$dynamic();
}

type RefundRequestRow = Awaited<
  ReturnType<ReturnType<typeof selectRefundRequests>["all"]>
>[number];

function withRefundableAmount(row: RefundRequestRow) {
  return {
    ...row,
    refundableAmount: getRefundableAmount(row, row.coursePrice),
  };
}

function getPendingRefundRequests() {
  return selectRefundRequests()
    .where(eq(refunds.status, RefundStatus.Requested))
    .orderBy(asc(refunds.requestedAt))
    .all()
    .map(withRefundableAmount);
}

function getPendingRefundRequest(refundRequestId: number) {
  const row = selectRefundRequests()
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!row) {
    throw data("Refund request not found.", { status: 404 });
  }

  if (row.status !== RefundStatus.Requested) {
    throw data("This refund request has already been resolved.", {
      status: 409,
    });
  }

  return withRefundableAmount(row);
}

type PendingRefundRequest = ReturnType<typeof getPendingRefundRequest>;

function approveRefundRequest(request: PendingRefundRequest, adminId: number) {
  db.transaction((tx) => {
    tx.update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: request.refundableAmount,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: adminId,
      })
      .where(eq(refunds.id, request.id))
      .run();

    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, request.learnerId),
          eq(enrollments.courseId, request.courseId)
        )
      )
      .run();
  });
}

function declineRefundRequest(request: PendingRefundRequest, adminId: number) {
  db.update(refunds)
    .set({
      status: RefundStatus.Declined,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: adminId,
    })
    .where(eq(refunds.id, request.id))
    .run();
}

/**
 * The learner hears the outcome by email. There is no mail transport wired up
 * yet, so the built message goes to the server log.
 */
function buildRefundDecisionEmail(
  request: PendingRefundRequest,
  decision: RefundDecision
) {
  const outcome =
    decision === "approve"
      ? [
          `We approved your refund request for "${request.courseTitle}".`,
          `${formatPrice(request.refundableAmount)} is on its way back to you, and you no longer have access to the course.`,
        ]
      : [
          `We declined your refund request for "${request.courseTitle}".`,
          "You keep your access to the course.",
        ];

  return {
    to: request.learnerEmail,
    subject: `Refund ${decision === "approve" ? "approved" : "declined"} — ${request.courseTitle}`,
    body: [
      `Hi ${request.learnerName},`,
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
  return { refundRequests: getPendingRefundRequests() };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const parsed = parseFormData(await request.formData(), refundDecisionSchema);

  if (!parsed.success) {
    throw data("Invalid refund decision.", { status: 400 });
  }

  const { intent, refundRequestId } = parsed.data;
  const refundRequest = getPendingRefundRequest(refundRequestId);

  if (intent === "approve") {
    approveRefundRequest(refundRequest, admin.id);
  } else {
    declineRefundRequest(refundRequest, admin.id);
  }

  const email = buildRefundDecisionEmail(refundRequest, intent);
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { decision: intent };
}

type RefundRequestCardProps = {
  refundRequest: Route.ComponentProps["loaderData"]["refundRequests"][number];
};

// The card unmounts once its request is resolved, so the page-level component
// shares this fetcher key to announce the outcome.
const REFUND_DECISION_FETCHER_KEY = "refund-decision";

function useRefundDecisionToast() {
  const fetcher = useFetcher<typeof action>({
    key: REFUND_DECISION_FETCHER_KEY,
  });

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.decision) {
      toast.success(
        fetcher.data.decision === "approve"
          ? "Refund approved."
          : "Refund request declined."
      );
    }
  }, [fetcher.state, fetcher.data]);
}

function RefundRequestCard({ refundRequest }: RefundRequestCardProps) {
  const fetcher = useFetcher<typeof action>({
    key: REFUND_DECISION_FETCHER_KEY,
  });
  const isSubmitting = fetcher.state !== "idle";

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <RefundRequestSummary refundRequest={refundRequest} />
        <p className="text-sm">{refundRequest.reason}</p>
        <fetcher.Form method="post" className="flex gap-2">
          <input
            type="hidden"
            name="refundRequestId"
            value={refundRequest.id}
          />
          <Button
            type="submit"
            name="intent"
            value="approve"
            size="sm"
            disabled={isSubmitting}
          >
            Approve and refund {formatPrice(refundRequest.refundableAmount)}
          </Button>
          <Button
            type="submit"
            name="intent"
            value="decline"
            variant="outline"
            size="sm"
            disabled={isSubmitting}
          >
            Decline
          </Button>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

function RefundRequestSummary({ refundRequest }: RefundRequestCardProps) {
  return (
    <div>
      <Link
        to={`/courses/${refundRequest.courseSlug}`}
        className="font-medium hover:underline"
      >
        {refundRequest.courseTitle}
      </Link>
      <p className="text-sm text-muted-foreground">
        {refundRequest.learnerName} ({refundRequest.learnerEmail}) · paid{" "}
        {formatPrice(refundRequest.amountPaid)} · raised{" "}
        {new Date(refundRequest.requestedAt).toLocaleDateString()}
      </p>
    </div>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { refundRequests } = loaderData;
  useRefundDecisionToast();

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approving a request refunds the learner and removes their access to
          the course.
        </p>
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No refund requests are waiting.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((refundRequest) => (
            <RefundRequestCard
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
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
