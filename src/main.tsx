import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { SignIn } from './components/SignIn.tsx'
import { useSignedIn } from './services/account.ts'

/**
 * The app, or the door to it.
 *
 * Two people share this machine and share nothing inside the app, so the
 * account is not a setting the app reads -- it is the thing the app is mounted
 * under. Keying <App> on the name is what makes that true: signing out and
 * back in as the other person tears the whole tree down and builds it again,
 * so no piece of state that was read for one account at mount -- the saved
 * list, the applied list, a half-open panel -- can survive into the other's
 * session and be shown as theirs.
 */
function Root() {
  const who = useSignedIn()
  return who ? <App key={who} /> : <SignIn />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
