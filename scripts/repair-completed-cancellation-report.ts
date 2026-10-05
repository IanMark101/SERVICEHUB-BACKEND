import { prisma } from '../src/lib/prisma';
import { repairCompletedParticipantCancellationReport } from '../src/services/cancellation-report-finalization.service';
async function main() {
  const requestId = process.argv[2];
  if (!requestId) throw new Error('Supply the exact cancellation request ID to reconcile.');
  const repaired = await repairCompletedParticipantCancellationReport(requestId);
  const request = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, report: { select: { id: true, status: true, resolvedAt: true } } } });
  console.log(JSON.stringify({ repaired, requestStatus: request.status, report: request.report }));
}
main().finally(() => prisma.$disconnect()).catch(e => { console.error(e.message); process.exitCode = 1; });
