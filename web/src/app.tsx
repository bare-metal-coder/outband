import { createEffect, lazy, Match, onMount, Suspense, Switch, type JSX } from 'solid-js';
import { match, navigate, path } from './router';
import { Login } from './routes/Login';
import { NotFound } from './routes/NotFound';
import { refreshSession, session, sessionError, markSignedOut } from './state/session';
import { setUnauthorizedHandler, start, stop } from './state/devices';
import { Shell } from './ui/Shell';
import { Toasts } from './ui/Toasts';
import { Empty } from './ui/Empty';

const Devices = lazy(() => import('./routes/Devices'));
const Device = lazy(() => import('./routes/Device'));

function Routes(): JSX.Element {
  const device = () => match('/devices/:id/:tab?', path());
  return (
    <Suspense fallback={<div class="skeleton" style={{ width: '40%' }} />}>
      <Switch fallback={<NotFound />}>
        <Match when={path() === '/'}>
          <Devices />
        </Match>
        <Match when={device()}>{(p) => <Device id={p().id ?? ''} tab={p().tab} />}</Match>
      </Switch>
    </Suspense>
  );
}

export function App(): JSX.Element {
  onMount(() => void refreshSession());
  setUnauthorizedHandler(markSignedOut);

  const authed = () => session()?.authenticated === true;
  createEffect(() => {
    if (authed()) {
      start();
      if (path() === '/login') navigate('/', { replace: true });
    } else if (session()) {
      stop();
    }
  });

  return (
    <>
      <Switch>
        <Match when={!session() && sessionError()}>
          <Empty icon="alert" title="Cannot reach the Outband server">
            <p>{sessionError()}</p>
            <button class="btn" onClick={() => void refreshSession()}>
              Retry
            </button>
          </Empty>
        </Match>
        <Match when={!session()}>
          <div class="carrier" data-state="connecting" />
        </Match>
        <Match when={!authed()}>
          <Login />
        </Match>
        <Match when={authed()}>
          <Shell>
            <Routes />
          </Shell>
        </Match>
      </Switch>
      <Toasts />
    </>
  );
}
