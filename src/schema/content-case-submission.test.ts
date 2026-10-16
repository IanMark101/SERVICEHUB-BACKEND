import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentCaseSubmissionSchema, ContentReportReasonSchema } from './content-case-submission.schema';

const base = { caseType: 'REPORT', contentType: 'SERVICE_LISTING', resourceId: 'cm1abcdefghijklmnopqrstuv', reason: 'The advertised price does not match the description.' };

test('listing and request reports validate each supported report reason', () => {
  for (const contentType of ['SERVICE_LISTING', 'SERVICE_REQUEST']) {
    for (const reportReason of ContentReportReasonSchema.options) {
      assert.equal(ContentCaseSubmissionSchema.parse({ ...base, contentType, reportReason }).reportReason, reportReason);
    }
  }
});
test('unknown or empty report reasons and incomplete messages are rejected', () => {
  for (const reportReason of ['', 'PRIVATE_BOOKING', null, 1]) {
    assert.equal(ContentCaseSubmissionSchema.safeParse({ ...base, reportReason }).success, false);
  }
  assert.equal(ContentCaseSubmissionSchema.safeParse({ ...base, reportReason: 'OTHER', reason: 'short' }).success, false);
  assert.equal(ContentCaseSubmissionSchema.safeParse({ ...base, reportReason: 'OTHER', reason: 'a'.repeat(1001) }).success, false);
});
test('older clients remain compatible and appeals do not gain report categories', () => {
  assert.equal(ContentCaseSubmissionSchema.safeParse(base).success, true);
  assert.equal(ContentCaseSubmissionSchema.safeParse({ ...base, caseType: 'APPEAL' }).success, true);
  assert.equal(ContentCaseSubmissionSchema.safeParse({ ...base, caseType: 'APPEAL', reportReason: 'SCAM' }).success, false);
});
