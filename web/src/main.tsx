import { render } from 'solid-js/web';
import './styles/app.css';
import './state/theme';
import { App } from './app';

render(() => <App />, document.getElementById('app')!);
