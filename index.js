/* eslint-disable max-lines */

'use strict';

const { WebClient } = require('@slack/client');
const config = require('./teamconfig');
// const getConfig = require('probot-config')
// const { MongoClient } = require('mongodb');

// const connect = MongoClient.connect(process.env.MONGO_URL);
// const db = connect.then(client => client.db(process.env.MONGO_DB));

// let config = await getConfig(context, 'reviewflow.yml');

const initTeamSlack = async (context, config) => {
  const githubLoginToSlackEmail = { ...config.dev, ...config.design };

  const slackClient = new WebClient(config.slackToken);
  const allUsers = await slackClient.users.list({ limit: 200 });
  const members = new Map(
    [...Object.values(config.dev), ...Object.values(config.design)].map(email => {
      const member = allUsers.members.find(user => user.profile.email === email);
      if (!member) {
        console.warn(`Could not find user ${email}`);
      }
      return [email, { member }];
    })
  );

  for (const user of members.values()) {
    try {
      const im = await slackClient.im.open({ user: user.member.id });
      user.im = im.channel;
    } catch (err) {
      console.error(err);
    }
  }

  const getUserFromGithubLogin = githubLogin => {
    const email = githubLoginToSlackEmail[githubLogin];
    if (!email) return null;
    return members.get(email);
  };

  return {
    mention: githubLogin => {
      const user = getUserFromGithubLogin(githubLogin);
      if (!user) return githubLogin;
      return `<@${user.member.id}>`;
    },
    postMessage: (githubLogin, text) => {
      context.log.info('send slack', { githubLogin, text });
      if (process.env.DRY_RUN) return;

      const user = getUserFromGithubLogin(githubLogin);
      if (!user || !user.im) return;
      return slackClient.chat.postMessage({
        channel: user.im.id,
        text,
      });
    },
  };
};

const initTeamContext = async (context, config) => {
  const slackPromise = initTeamSlack(context, config);

  const githubLoginToGroup = new Map([
    ...Object.keys(config.dev || {}).map(login => [login, 'dev']),
    ...Object.keys(config.design || {}).map(login => [login, 'design']),
  ]);

  const getReviewerGroups = githubLogins => [
    ...new Set(
      githubLogins.map(githubLogin => githubLoginToGroup.get(githubLogin)).filter(Boolean)
    ),
  ];

  return {
    config,
    getReviewerGroup: githubLogin => githubLoginToGroup.get(githubLogin),
    getReviewerGroups: githubLogins => [
      ...new Set(
        githubLogins.map(githubLogin => githubLoginToGroup.get(githubLogin)).filter(Boolean)
      ),
    ],

    reviewShouldWait: (
      reviewerGroup,
      requestedReviewers,
      { includesReviewerGroup, includesWaitForGroups }
    ) => {
      if (!reviewerGroup) return false;

      const requestedReviewerGroups = getReviewerGroups(
        requestedReviewers.map(request => request.login)
      );

      // contains another request of a reviewer in the same group
      if (includesReviewerGroup && requestedReviewerGroups.includes(reviewerGroup)) return true;

      // contains a request from a dependent group
      if (includesWaitForGroups)
        return requestedReviewerGroups.some(group =>
          config.waitForGroups[reviewerGroup].includes(group)
        );

      return false;
    },

    slack: await slackPromise,
  };
};

const teamContextsPromise = new Map();
const teamContexts = new Map();

const obtainTeamContext = context => {
  const owner = context.payload.repository.owner;
  if (owner.login !== 'ornikar') {
    console.warn(owner.login);
    return null;
  }

  const existingTeamContext = teamContexts.get(owner.login);
  if (existingTeamContext) return existingTeamContext;

  const existingPromise = teamContextsPromise.get(owner.login);
  if (existingPromise) return Promise.resolve(existingPromise);

  const promise = initTeamContext(context, config);
  teamContextsPromise.set(owner.login, promise);

  return promise.then(teamContext => {
    teamContextsPromise.delete(owner.login);
    teamContexts.set(owner.login, teamContext);
    return teamContext;
  });
};

const initRepoLabels = async (context, config) => {
  const { data: labels } = await context.github.issues.getLabels(context.repo({ per_page: 100 }));
  const finalLabels = {};

  for (const [labelKey, labelConfig] of Object.entries(config.labels.list)) {
    const labelColor = labelConfig.color.slice(1);
    const description = `Generated by review-flow for ${labelKey}`;

    let existingLabel = labels.find(label => label.name === labelConfig.name);
    if (!existingLabel) {
      existingLabel = labels.find(label => label.description === description);
    }
    if (!existingLabel) {
      if (labelKey === 'design/needs-review')
        existingLabel = labels.find(label => label.name === 'needs-design-review');
      if (labelKey === 'design/approved')
        existingLabel = labels.find(label => label.name === 'design-reviewed');
    }

    if (!existingLabel) {
      const result = await context.github.issues.createLabel(
        context.repo({
          name: labelConfig.name,
          color: labelColor,
          description,
        })
      );
      finalLabels[labelKey] = result.data;
    } else if (
      existingLabel.name !== labelConfig.name ||
      existingLabel.color !== labelColor // ||
      // TODO: description is always undefined
      // existingLabel.description !== description
    ) {
      context.log.info('Needs to update label', {
        current_name: existingLabel.name,
        name: existingLabel.name !== labelConfig.name && labelConfig.name,
        color: existingLabel.color !== labelColor && labelColor,
        description: existingLabel.description !== description && description,
      });

      const result = await context.github.issues.updateLabel(
        context.repo({
          current_name: existingLabel.name,
          name: labelConfig.name,
          color: labelColor,
          description,
        })
      );
      finalLabels[labelKey] = result.data;
    } else {
      finalLabels[labelKey] = existingLabel;
    }
  }

  return finalLabels;
};

const initRepoContext = async (context, config) => {
  const teamContext = await obtainTeamContext(context, config);
  const repoContext = Object.create(teamContext);

  const labels = await initRepoLabels(context, config);

  return Object.assign(repoContext, {
    updateLabels: async (context, { add: labelsToAdd, remove: labelsToRemove }) => {
      const prLabels = context.payload.pull_request.labels || [];
      const newLabels = new Set(prLabels.map(label => label.name));
      let modified = false;

      if (labelsToAdd) {
        labelsToAdd.map(key => key && labels[key]).forEach(label => {
          if (!label || prLabels.some(prLabel => prLabel.id === label.id)) return;
          newLabels.add(label.name);
          modified = true;
        });
      }

      if (labelsToRemove) {
        labelsToRemove.map(key => key && labels[key]).forEach(label => {
          if (!label) return;
          const existing = prLabels.find(prLabel => prLabel.id === label.id);
          newLabels.remove(existing.name);
          modified = true;
        });
      }

      context.log.info('updateLabels', {
        modified,
        oldLabels: prLabels.map(l => l.name),
        newLabels: [...newLabels],
      });

      if (process.env.DRY_RUN) return;

      if (modified) {
        await context.github.issues.replaceLabels(
          context.issue({
            labels: [...newLabels],
          })
        );
      }
    },
  });
};

const repoContextsPromise = new Map();
const repoContexts = new Map();

const obtainRepoContext = context => {
  const owner = context.payload.repository.owner;
  if (owner.login !== 'ornikar') {
    console.warn(owner.login);
    return null;
  }
  const key = context.payload.repository.id;

  const existingRepoContext = teamContexts.get(key);
  if (existingRepoContext) return existingRepoContext;

  const existingPromise = repoContextsPromise.get(key);
  if (existingPromise) return Promise.resolve(existingPromise);

  const promise = initRepoContext(context, config);
  repoContextsPromise.set(key, promise);

  return promise.then(repoContext => {
    repoContextsPromise.delete(key);
    repoContexts.set(key, repoContext);
    return repoContext;
  });
};

/*
* This is the entry point for your Probot App.
* @param {import('probot').Application} app - Probot's Application class.
*/
module.exports = app => {
  app.on('pull_request.opened', async context => {
    const repoContext = await obtainRepoContext(context);
    if (!repoContext) return;

    if (repoContext.config.autoAssignToCreator) {
      const pr = context.payload.pull_request;
      if (pr.assignees.length !== 0) return;

      await context.github.issues.addAssigneesToIssue(
        context.issue({
          assignees: [pr.user.login],
        })
      );
    }
  });

  app.on('pull_request.review_requested', async context => {
    const repoContext = await obtainRepoContext(context);
    if (!repoContext) return;
    const sender = context.payload.sender;

    // ignore if sender is self (dismissed review rerequest review)
    if (sender.type === 'bot') return;

    const pr = context.payload.pull_request;
    const reviewer = context.payload.requested_reviewer;

    const reviewerGroup = repoContext.getReviewerGroup(reviewer.login);
    const shouldWait = false;
    // repoContext.reviewShouldWait(reviewerGroup, pr.requested_reviewers, { includesWaitForGroups: true });

    if (config.labels.review[reviewerGroup]) {
      const { data: reviews } = await context.github.pullRequests.getReviews(
        context.issue({ per_page: 50 })
      );
      const hasRequestChangesInReviews = reviews.some(
        review =>
          repoContext.getReviewerGroup(review.user.login) === reviewerGroup &&
          review.state === 'REQUEST_CHANGES'
      );

      if (!hasRequestChangesInReviews) {
        repoContext.updateLabels(context, {
          add: [config.labels.review[reviewerGroup][shouldWait ? 'needsReview' : 'requested']],
          remove: [config.labels.review[reviewerGroup].approved],
        });
      }
    }

    if (sender.login === reviewer.login) return;

    if (!shouldWait) {
      repoContext.slack.postMessage(
        reviewer.login,
        `${repoContext.slack.mention(sender.login)} requested your review on ${pr.html_url}`
      );
    }
  });

  app.on('pull_request.review_request_removed', async context => {
    const repoContext = await obtainRepoContext(context);
    if (!repoContext) return;
    const sender = context.payload.sender;
    const pr = context.payload.pull_request;
    const reviewer = context.payload.requested_reviewer;

    const reviewerGroup = repoContext.getReviewerGroup(reviewer.login);

    const hasRequestedReviewsForGroup = repoContext.reviewShouldWait(
      reviewerGroup,
      pr.requested_reviewers,
      {
        includesReviewerGroup: true,
      }
    );

    if (config.labels.review[reviewerGroup] && !hasRequestedReviewsForGroup) {
      const { data: reviews } = await context.github.pullRequests.getReviews(
        context.issue({ per_page: 50 })
      );
      const hasApprovedInReviews = reviews.some(
        review =>
          repoContext.getReviewerGroup(review.user.login) === reviewerGroup &&
          review.state === 'APPROVED'
      );

      repoContext.updateLabels(context, {
        // add label approved if was already approved by another member in the group and has no other requests waiting
        add: [hasApprovedInReviews && config.labels.review[reviewerGroup].approved],
        // remove labels if has no otehr requests waiting
        remove: [
          config.labels.review[reviewerGroup].needsReview,
          config.labels.review[reviewerGroup].requested,
        ],
      });
    }

    if (sender.login === reviewer.login) return;

    repoContext.slack.postMessage(
      reviewer.login,
      `${repoContext.slack.mention(sender.login)} removed the request for your review on ${
        pr.html_url
      }`
    );
  });

  // app.on('pull_request.closed', async context => {

  // });

  // app.on('pull_request.reopened', async context => {

  // });

  app.on('pull_request_review.submitted', async context => {
    const repoContext = await obtainRepoContext(context);
    if (!repoContext) return;
    const pr = context.payload.pull_request;
    const { user: reviewer, state } = context.payload.review;
    if (pr.user.login === reviewer.login) return;

    if (state === 'changes_requested' || state === 'approved') {
      const reviewerGroup = repoContext.getReviewerGroup(reviewer.login);

      if (reviewerGroup && config.labels.review[reviewerGroup]) {
        const hasRequestedReviewsForGroup = repoContext.reviewShouldWait(
          reviewerGroup,
          pr.requested_reviewers,
          {
            includesReviewerGroup: true,
            // TODO reenable this when accepted can notify request review to slack (dev accepted => design requested) and flag to disable for label (approved design ; still waiting for dev ?)
            // includesWaitForGroups: true,
          }
        );
        const { data: reviews } = await context.github.pullRequests.getReviews(
          context.issue({ per_page: 50 })
        );
        const hasChangesRequestedInReviews = reviews.some(
          review =>
            repoContext.getReviewerGroup(review.user.login) === reviewerGroup &&
            review.state === 'REQUEST_CHANGES'
        );

        if (!hasChangesRequestedInReviews) {
          repoContext.updateLabels(context, {
            add: [
              state === 'approved' &&
                !hasRequestedReviewsForGroup &&
                config.labels.review[reviewerGroup].approved,
              state === 'changes_requested' && config.labels.review[reviewerGroup].changesRequested,
            ],
            remove: [
              (!hasRequestedReviewsForGroup || state === 'changes_requested') &&
                config.labels.review[reviewerGroup].needsReview,
              (!hasRequestedReviewsForGroup || state === 'changes_requested') &&
                config.labels.review[reviewerGroup].requested,
              state === 'approved' &&
                !hasRequestedReviewsForGroup &&
                config.labels.review[reviewerGroup].changesRequested,
              state === 'changes_requested' && config.labels.review[reviewerGroup].approved,
            ],
          });
        }
      }
    }

    const message = (() => {
      if (state === 'changes_requested') return ':x: requested changes on';
      if (state === 'approved') return ':white_check_mark: approved';
      return 'commented on';
    })();

    repoContext.slack.postMessage(
      pr.user.login,
      `${repoContext.slack.mention(reviewer.login)} ${message} ${pr.html_url}`
    );
  });

  app.on('pull_request_review.dismissed', async context => {
    const repoContext = await obtainRepoContext(context);
    if (!repoContext) return;
    const sender = context.payload.sender;
    const pr = context.payload.pull_request;
    const reviewer = context.payload.review.user;

    const reviewerGroup = repoContext.getReviewerGroup(reviewer.login);

    if (reviewerGroup && config.labels.review[reviewerGroup]) {
      const { data: reviews } = await context.github.pullRequests.getReviews(
        context.issue({ per_page: 50 })
      );
      const hasChangesRequestedInReviews = reviews.some(
        review =>
          repoContext.getReviewerGroup(review.user.login) === reviewerGroup &&
          review.state === 'REQUEST_CHANGES'
      );

      if (!hasChangesRequestedInReviews) {
        repoContext.updateLabels(context, {
          add: [config.labels.review[reviewerGroup].requested],
          remove: [
            config.labels.review[reviewerGroup].changesRequested,
            config.labels.review[reviewerGroup].approved,
          ],
        });
      }
    }

    context.github.pullRequests.createReviewRequest(
      context.issue({
        reviewers: [reviewer.login],
      })
    );

    // if (sender.login === reviewer.login) {
    //   repoContext.slack.postMessage(
    //     pr.user.login,
    //     `${repoContext.slack.mention(reviewer.login)} dismissed his review on ${pr.html_url}`
    //   );
    // } else {
    //   repoContext.slack.postMessage(
    //     reviewer.login,
    //     `${repoContext.slack.mention(sender.login)} dismissed your review on ${
    //       pr.html_url
    //     }, he requests a new one !`
    //   );
    // }

    repoContext.slack.postMessage(reviewer.login, `Your review was dismissed on ${pr.html_url}`);
  });
};
