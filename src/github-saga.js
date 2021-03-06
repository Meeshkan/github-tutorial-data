import {
  GET_REPO,
  GET_REPO_SUCCESS,
  GET_REPO_FAILURE,
  GET_REPOS,
  GET_REPOS_SUCCESS,
  GET_REPOS_FAILURE,
  GET_LAST,
  GET_LAST_SUCCESS,
  GET_LAST_FAILURE,
  GET_COMMIT,
  GET_COMMIT_SUCCESS,
  GET_COMMIT_FAILURE,
  GET_COMMITS,
  GET_COMMITS_SUCCESS,
  GET_COMMITS_FAILURE,
  GET_TASKS,
  GET_TASKS_SUCCESS,
  GET_TASKS_FAILURE,
  DO_CLEANUP,
  END_SCRIPT,
  DEFER_ACTION,
  DEFER_ACTION_SUCCESS,
  DEFER_ACTION_FAILURE,
  SPAWN_SERVER_SUCCESS,
  END_SCRIPT_FAILURE,
  SCRIPT_NO_LONGER_NEEDS_CONNECTION,
  getTasks,
  deferAction,
  decreaseRemaining,
  endScript,
} from './actions';

import _ from 'lodash';

import uuidv4 from 'uuid/v4';

import urlparse from 'url-parse';

import axios from 'axios';

import {
  INSERT_REPO_STMT,
  INSERT_COMMIT_STMT,
  INSERT_DEFERRED_STMT,
  SELECT_DEFERRED_STMT,
  DELETE_DEFERRED_STMT,
  SELECT_UNFULFILLED_STMT,
  INCREASE_EXECUTING_STATEMENT,
  SELECT_EXECUTING_STATEMENT,
  DECREASE_EXECUTING_STATEMENT
} from './sql';

import {
  call,
  put,
  select,
  takeEvery,
  race,
  take
} from 'redux-saga/effects';

import {
  sqlPromise,
} from './util';

import AWS from 'aws-sdk';

export const stateSelector = $ => $;
export const EAI_AGAIN = "EAI_AGAIN";

export const uuidsToRace = (...args) => race(_.fromPairs(args.map(x => [x, take(x)])));

export function* doCleanup(uuid) {
  yield call(getTasksSideEffect, {});
  yield put({
    type: `${uuid}_DONE`
  });
}

export function* deferActionSideEffect(action) {
  const {
    connection,
    env
  } = yield select(stateSelector);
  const {
    payload
  } = action;
  const uuid = yield call(uuidv4);
  try {
    yield call(sqlPromise, connection, INSERT_DEFERRED_STMT, [payload.meta.uuid, payload.type, JSON.stringify(payload)]);
    yield put({
      type: DEFER_ACTION_SUCCESS,
      payload,
      meta: {
        uuid
      }
    });
  } catch (e) {
    yield put({
      type: DEFER_ACTION_FAILURE,
      payload,
      meta: {
        uuid
      },
      error: e
    });
  } finally {
    yield take(`${uuid}_LOGGED`);
    yield call(doCleanup, payload.meta.uuid);
  }
}

export function* getTasksSideEffect(action) {
  const {
    meta
  } = action;
  try {
    while (true) {
      const {
        connection,
        env,
        remaining
      } = yield select(stateSelector);
      if (remaining > 0) {
        const uuid = yield call(uuidv4);
        const tasks = yield call(sqlPromise, connection, SELECT_DEFERRED_STMT, [remaining]);
        let i = 0;
        let j = 0;
        const tasksToPut = [];
        for (; i < tasks.length; i++) {
          const delRes = yield call(sqlPromise, connection, DELETE_DEFERRED_STMT, [tasks[i].id]);
          if (delRes.affectedRows) {
            tasksToPut.push(JSON.parse(tasks[i].json));
            j++;
          }
        }
        let k = 0;
        for (; k < j; k++) {
          yield put(tasksToPut[k]);
        }
        yield put({
          type: GET_TASKS_SUCCESS,
          payload: {
            asked: i,
            got: j
          },
          meta: {
            uuid
          }
        });
        const races = tasksToPut.map(x => `${x.meta.uuid}_DONE`).concat(`${uuid}_LOGGED`);
        k = 0;
        for (; k < races.length; k++) {
          yield uuidsToRace(...races);
        }
        if (!tasks.length) {
          break;
        }
      } else {
        break;
      }
    }
  } catch (e) {
    const uuid = yield call(uuidv4);
    yield put({
      type: GET_TASKS_FAILURE,
      payload: action.payload,
      meta: {
        uuid
      },
      error: e
    });
    yield take(`${uuid}_LOGGED`);
  } finally {
    if (meta && meta.isInitial) {
      yield put(endScript());
    }
  }
}

export function* getRepoSideEffect(action) {
  const {
    connection,
    env
  } = yield select(stateSelector);
  const {
    payload,
    meta
  } = action;
  try {
    const repo = yield call(axios, `${env.GITHUB_API}/repos/${payload._computationOwner}/${payload._computationRepo}`);
    const fork = repo && repo.data ? repo.data.fork : null;
    if (fork) {
      throw new Error("no forks allowed"); // we do not use forks
    }
    const id = repo && repo.data ? parseInt(repo.data.id) : null;
    if (id === null) {
      throw new Error("no id error"); // cannot insert into the DB without an id
    }
    const owner_login = repo && repo.data && repo.data.owner ? repo.data.owner.login : null;
    const owner_id = repo && repo.data && repo.data.owner ? parseInt(repo.data.owner.id) : null;
    const name = repo && repo.data ? repo.data.name : null;
    const full_name = repo && repo.data ? repo.data.full_name : null;
    const language = repo && repo.data ? repo.data.language : null;
    const forks_count = repo && repo.data ? parseInt(repo.data.forks_count) : null;
    const stargazers_count = repo && repo.data ? parseInt(repo.data.stargazers_count) : null;
    const watchers_count = repo && repo.data ? parseInt(repo.data.watchers_count) : null;
    const subscribers_count = repo && repo.data ? parseInt(repo.data.subscribers_count) : null;
    const size = repo && repo.data ? parseInt(repo.data.size) : null;
    const has_issues = repo && repo.data ? repo.data.has_issues ? 1 : 0 : null;
    const has_wiki = repo && repo.data ? repo.data.has_wiki ? 1 : 0 : null;
    const has_pages = repo && repo.data ? repo.data.has_pages ? 1 : 0 : null;
    const has_downloads = repo && repo.data ? repo.data.has_downloads ? 1 : 0 : null;
    const pushed_at = repo && repo.data && repo.data.pushed_at ? new Date(repo.data.pushed_at).getTime() : null;
    const created_at = repo && repo.data && repo.data.created_at ? new Date(repo.data.created_at).getTime() : null;
    const updated_at = repo && repo.data && repo.data.updated_at ? new Date(repo.data.updated_at).getTime() : null;
    yield call(sqlPromise, connection, INSERT_REPO_STMT, [
      id, owner_login, owner_id, name, full_name, language, forks_count, stargazers_count, watchers_count, subscribers_count, size, has_issues, has_wiki, has_pages, has_downloads, pushed_at, created_at, updated_at,
      owner_login, owner_id, name, full_name, language, forks_count, stargazers_count, watchers_count, subscribers_count, size, has_issues, has_wiki, has_pages, has_downloads, pushed_at, created_at, updated_at
    ]);
    const uuid = yield call(uuidv4);
    yield put({
      type: GET_LAST,
      payload: {
        _computationId: id,
        _computationOwner: payload._computationOwner,
        _computationRepo: payload._computationRepo
      },
      meta: {
        uuid
      }
    });
    yield put({
      type: GET_REPO_SUCCESS,
      payload,
      meta,
    });
    let i = 0;
    for (; i < 2; i++) {
      yield uuidsToRace(`${uuid}_DONE`, `${meta.uuid}_LOGGED`);
    }
  } catch (e) {
    yield put({
      type: GET_REPO_FAILURE,
      payload,
      meta,
      error: e
    });
    yield take(`${meta.uuid}_LOGGED`);
    if (e.code && e.code === EAI_AGAIN) {
      yield put(deferAction(action));
    }
  } finally {
    yield call(doCleanup, meta.uuid);
  }
}

export function* getReposSideEffect(action) {
  const {
    connection,
    env
  } = yield select(stateSelector);
  const {
    payload,
    meta
  } = action;
  try {
    const repos = yield call(axios, `${env.GITHUB_API}/repositories?since=${payload._computationSince}`);
    let i = 0;
    const useableRepos = repos && repos.data ? repos.data.filter(r => !r.fork && r.name && r.owner && r.owner.login) : [];
    // uuids need to be generated by call upfront so that, if they have an async component, it does not get this function off its tick
    // max uuids we will need is usableRepos.length + 1
    const uuids = [];
    for (; i < useableRepos.length + 1; i++) {
      const uuid = yield call(uuidv4);
      uuids.push(uuid);
    }
    let getReposCalledAgain = false;
    if (repos && repos.data) {
      i = 0;
      for (; i < useableRepos.length; i++) {
        yield put({
          type: GET_REPO,
          payload: {
            _computationOwner: useableRepos[i].owner.login,
            _computationRepo: useableRepos[i].name
          },
          meta: {
            uuid: uuids[i]
          }
        }); // repo data
      }
      if (Object.keys(repos.headers).indexOf('link') === -1) {
        throw new Error(`header does not contain link: here are the headers ${Object.keys(repos.headers).join(',')}`);
      }
      const next = /<(.|\n)*?>/g.exec(repos.headers['link'].split(',').filter(x => x.indexOf('rel="next"') !== -1)[0])[0].replace('<', '').replace('>', '');
      const since = parseInt(urlparse(next).query.substring(1).split('&').filter(x => x.indexOf('since=') !== -1)[0].split('=')[1]);
      const updatedCount = parseInt(payload._computationReposCount || 0) + useableRepos.length;
      if (updatedCount < parseInt(env.MAX_REPOS)) {
        getReposCalledAgain = true;
        yield put({
          type: GET_REPOS,
          payload: {
            _computationSince: since,
            _computationReposCount: updatedCount
          },
          meta: {
            uuid: uuids[uuids.length - 1]
          }
        }); // get next batch of repos
      }
    }
    yield put({
      type: GET_REPOS_SUCCESS,
      payload,
      meta,
    });
    i = 0;
    const races = (getReposCalledAgain ? uuids.slice() : uuids.slice(0, -1)).map(x => `${x}_DONE`).concat(`${meta.uuid}_LOGGED`);
    for (; i < races.length; i++) {
      yield uuidsToRace(...races);
    }
  } catch (e) {
    yield put({
      type: GET_REPOS_FAILURE,
      payload,
      meta,
      error: e
    });
    yield take(`${meta.uuid}_LOGGED`);
    if (e.code && e.code === EAI_AGAIN) {
      yield put(deferAction(action));
    }
  } finally {
    yield call(doCleanup, meta.uuid);
    if (meta.isInitial) {
      yield put(endScript());
    }
  }
}

export function* getLastSideEffect(action) {
  const {
    connection,
    env
  } = yield select(stateSelector);
  const {
    payload,
    meta
  } = action;
  try {
    const url = `https://api.github.com/repos/${payload._computationOwner}/${payload._computationRepo}/commits`;
    const commit = yield call(axios, url);
    let doingGetCommits = false;
    const uuid = yield call(uuidv4);
    if (Object.keys(commit.headers).indexOf('link') !== -1) {
      const last = /<(.|\n)*?>/g.exec(commit.headers['link'].split(',').filter(x => x.indexOf('rel="last"') !== -1)[0])[0].replace('<', '').replace('>', '');
      const page = parseInt(urlparse(last).query.substring(1).split('&').filter(x => x.indexOf('page=') !== -1)[0].split('=')[1]);
      doingGetCommits = true;
      yield put({
        type: GET_COMMITS,
        payload: {
          _computationPage: page,
          _computationCommitCount: 0,
          _computationId: payload._computationId,
          _computationOwner: payload._computationOwner,
          _computationRepo: payload._computationRepo
        },
        meta: {
          uuid
        }
      }); // get commits
    }
    yield put({
      type: GET_LAST_SUCCESS,
      payload,
      meta,
    });
    let i = 0;
    const races = (doingGetCommits ? [`${uuid}_DONE`] : []).concat(`${meta.uuid}_LOGGED`);
    for (; i < races.length; i++) {
      yield uuidsToRace(...races);
    }
  } catch (e) {
    yield put({
      type: GET_LAST_FAILURE,
      payload,
      meta,
      error: e
    });
    yield take(`${meta.uuid}_LOGGED`);
    if (e.code && e.code === EAI_AGAIN) {
      yield put(deferAction(action));
    }
  } finally {
    yield call(doCleanup, meta.uuid);
  }
}

export function* getCommitsSideEffect(action) {
  const {
    connection,
    env
  } = yield select(stateSelector);
  const {
    payload,
    meta
  } = action;
  try {
    const commits = yield call(axios, `https://api.github.com/repositories/${payload._computationId}/commits?page=${payload._computationPage}`);
    const useableCommits = commits && commits.data && commits.data.length ? commits.data.filter(x => x.sha) : [];
    const uuids = [];
    let i = 0;
    for (; i < useableCommits.length + 1; i++) {
      const uuid = yield call(uuidv4);
      uuids.push(uuid);
    }
    let getCommitsCalledAgain = false;
    if (commits && commits.data && commits.data.length) {
      i = 0;
      for (; i < useableCommits.length; i++) {
        yield put({
          type: GET_COMMIT,
          payload: {
            _computationId: payload._computationId,
            _computationSHA: useableCommits[i].sha,
            _computationOwner: payload._computationOwner,
            _computationRepo: payload._computationRepo
          },
          meta: {
            uuid: uuids[i]
          }
        }); // commit data;
      }
      const updatedCount = parseInt(payload._computationCommitCount || 0) + useableCommits.length;
      if (payload._computationPage > 1 && updatedCount < parseInt(env.MAX_COMMITS)) {
        getCommitsCalledAgain = true;
        yield put({
          type: GET_COMMITS,
          payload: {
            _computationPage: payload._computationPage - 1,
            _computationCommitCount: updatedCount,
            _computationId: payload._computationId,
            _computationOwner: payload._computationOwner,
            _computationRepo: payload._computationRepo
          },
          meta: {
            uuid: uuids[uuids.length - 1]
          }
        }); // get commits again
      }
    }
    yield put({
      type: GET_COMMITS_SUCCESS,
      payload,
      meta
    });
    const races = (getCommitsCalledAgain ? uuids.slice() : uuids.slice(0, -1)).map(x => `${x}_DONE`).concat(`${meta.uuid}_LOGGED`);
    i = 0;
    for (; i < races.length; i++) {
      yield uuidsToRace(...races);
    }
  } catch (e) {
    yield put({
      type: GET_COMMITS_FAILURE,
      payload,
      meta,
      error: e
    });
    yield take(`${meta.uuid}_LOGGED`);
    if (e.code && e.code === EAI_AGAIN) {
      yield put(deferAction(action));
    }
  } finally {
    yield call(doCleanup, meta.uuid);
  }
}

export function* getCommitSideEffect(action) {
  const {
    connection,
    env
  } = yield select(stateSelector);
  const {
    payload,
    meta
  } = action;
  try {
    const commit = yield call(axios, `${env.GITHUB_API}/repos/${payload._computationOwner}/${payload._computationRepo}/commits/${payload._computationSHA}`);
    const sha = commit && commit.data ? commit.data.sha : null;
    if (sha === null) {
      throw new Error("no sha error"); // cannot insert into the DB without an sha
    }
    const repo_id = parseInt(payload._computationId);
    const author_name = commit && commit.data && commit.data.commit && commit.data.commit.author ? commit.data.commit.author.name : null;
    const author_email = commit && commit.data && commit.data.commit && commit.data.commit.author ? commit.data.commit.author.email : null;
    const author_date = commit && commit.data && commit.data.commit && commit.data.commit.author ? new Date(commit.data.commit.author.date).getTime() : null;
    const committer_name = commit && commit.data && commit.data.commit && commit.data.commit.committer ? commit.data.commit.committer.name : null;
    const committer_email = commit && commit.data && commit.data.commit && commit.data.commit.committer ? commit.data.commit.committer.email : null;
    const committer_date = commit && commit.data && commit.data.commit && commit.data.commit.committer ? new Date(commit.data.commit.committer.date).getTime() : null;
    const author_login = commit && commit.data && commit.data.author ? commit.data.author.login : null;
    const author_id = commit && commit.data && commit.data.author ? parseInt(commit.data.author.id || 0) : null;
    const committer_login = commit && commit.data && commit.data.committer ? commit.data.committer.login : null;
    const committer_id = commit && commit.data && commit.data.committer ? parseInt(commit.data.committer.id || 0) : null;
    const additions = commit && commit.data && commit.data.stats ? parseInt(commit.data.stats.additions || 0) : null;
    const deletions = commit && commit.data && commit.data.stats ? parseInt(commit.data.stats.deletions || 0) : null;
    const total = commit && commit.data && commit.data.stats ? parseInt(commit.data.stats.total || 0) : null;
    const test_additions = commit && commit.data && commit.data.files ? commit.data.files.filter(f => f.filename && /(^test|[^a-zA-Z]+test|Test)/g.exec(f.filename)).map(f => parseInt(f.additions || 0)).reduce((a, b) => a + b, 0) : null;
    const test_deletions = commit && commit.data && commit.data.files ? commit.data.files.filter(f => f.filename && /(^test|[^a-zA-Z]+test|Test)/g.exec(f.filename)).map(f => parseInt(f.deletions || 0)).reduce((a, b) => a + b, 0) : null;
    const test_changes = commit && commit.data && commit.data.files ? commit.data.files.filter(f => f.filename && /(^test|[^a-zA-Z]+test|Test)/g.exec(f.filename)).map(f => parseInt(f.changes || 0)).reduce((a, b) => a + b, 0) : null;
    yield call(sqlPromise, connection, INSERT_COMMIT_STMT, [
      sha, repo_id, author_name, author_email, author_date, committer_name, committer_email, committer_date, author_login, author_id, committer_login, committer_id, additions, deletions, total, test_additions, test_deletions, test_changes,
      repo_id, author_name, author_email, author_date, committer_name, committer_email, committer_date, author_login, author_id, committer_login, committer_id, additions, deletions, total, test_additions, test_deletions, test_changes
    ]); // update commit
    yield put({
      type: GET_COMMIT_SUCCESS,
      payload,
      meta
    });
    yield take(`${meta.uuid}_LOGGED`);
  } catch (e) {
    yield put({
      type: GET_COMMIT_FAILURE,
      payload,
      meta,
      error: e
    });
    yield take(`${meta.uuid}_LOGGED`);
    if (e.code && e.code === EAI_AGAIN) {
      yield put(deferAction(action));
    }
  } finally {
    yield call(doCleanup, meta.uuid);
  }
}

function* githubSaga() {
  yield takeEvery(GET_LAST, getLastSideEffect);
  yield takeEvery(GET_COMMIT, getCommitSideEffect);
  yield takeEvery(GET_COMMITS, getCommitsSideEffect);
  yield takeEvery(GET_REPO, getRepoSideEffect);
  yield takeEvery(GET_REPOS, getReposSideEffect);
  yield takeEvery(GET_TASKS, getTasksSideEffect);
  yield takeEvery(DEFER_ACTION, deferActionSideEffect);
}

export default githubSaga;