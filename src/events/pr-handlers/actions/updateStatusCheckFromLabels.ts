import type { EventPayloads } from '@octokit/webhooks';
import type { Context } from 'probot';
import type { RepoContext } from 'context/repoContext';
import type {
  PullRequestLabels,
  PullRequestWithDecentData,
} from '../utils/PullRequestData';
import createStatus from './utils/createStatus';

const addStatusCheck = async function <
  T extends { repository: EventPayloads.PayloadRepository }
>(
  pullRequest: PullRequestWithDecentData,
  context: Context<T>,
  { state, description }: { state: 'failure' | 'success'; description: string },
  previousSha?: string,
): Promise<void> {
  const hasPrCheck = (
    await context.octokit.checks.listForRef(
      context.repo({
        ref: pullRequest.head.sha,
      }),
    )
  ).data.check_runs.find((check) => check.name === process.env.REVIEWFLOW_NAME);

  context.log.debug({ hasPrCheck, state, description }, 'add status check');

  if (hasPrCheck) {
    await context.octokit.checks.create(
      context.repo({
        name: process.env.REVIEWFLOW_NAME as string,
        head_sha: pullRequest.head.sha,
        started_at: pullRequest.created_at,
        status: 'completed',
        conclusion: state,
        completed_at: new Date().toISOString(),
        output: {
          title: description,
          summary: '',
        },
      }),
    );
  } else if (previousSha && state === 'failure') {
    await Promise.all([
      createStatus(
        context,
        '',
        previousSha,
        'success',
        'New commits have been pushed',
      ),
      createStatus(context, '', pullRequest.head.sha, state, description),
    ]);
  } else {
    await createStatus(context, '', pullRequest.head.sha, state, description);
  }
};

export const updateStatusCheckFromLabels = <
  T extends { repository: EventPayloads.PayloadRepository }
>(
  pullRequest: PullRequestWithDecentData,
  context: Context<T>,
  repoContext: RepoContext,
  labels: PullRequestLabels = pullRequest.labels || [],
  previousSha?: string,
): Promise<void> => {
  context.log.debug(
    {
      labels: labels.map((l) => l?.name),
      hasNeedsReview: repoContext.hasNeedsReview(labels),
      hasApprovesReview: repoContext.hasApprovesReview(labels),
    },
    'updateStatusCheckFromLabels',
  );

  const createFailedStatusCheck = (description: string): Promise<void> =>
    addStatusCheck(
      pullRequest,
      context,
      {
        state: 'failure',
        description,
      },
      previousSha,
    );

  if (pullRequest.requested_reviewers.length > 0) {
    return createFailedStatusCheck(
      `Awaiting review from: ${pullRequest.requested_reviewers
        .map((rr) => rr.login)
        .join(', ')}`,
    );
  }

  if (repoContext.hasChangesRequestedReview(labels)) {
    return createFailedStatusCheck(
      'Changes requested ! Push commits or discuss changes then re-request a review.',
    );
  }

  const needsReviewGroupNames = repoContext.getNeedsReviewGroupNames(labels);

  if (needsReviewGroupNames.length > 0) {
    return createFailedStatusCheck(
      `Awaiting review from: ${needsReviewGroupNames.join(
        ', ',
      )}. Perhaps request someone ?`,
    );
  }

  if (!repoContext.hasApprovesReview(labels)) {
    if (repoContext.config.requiresReviewRequest) {
      return createFailedStatusCheck(
        'Awaiting review... Perhaps request someone ?',
      );
    }
  }

  // if (
  //   repoContext.config.requiresReviewRequest &&
  //   !repoContext.hasRequestedReview(labels)
  // ) {
  //   return  createFailedStatusCheck(
  //     context,
  //     pr,
  //     'You need to request someone to review the PR',
  //   );
  //   return;
  // }
  // return  createInProgressStatusCheck(context);
  // } else if (repoContext.hasApprovesReview(labels)) {
  return addStatusCheck(
    pullRequest,
    context,
    {
      state: 'success',
      description: '✓ PR ready to merge !',
    },
    previousSha,
  );
  // }
};
