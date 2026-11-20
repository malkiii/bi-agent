import { signIn } from '@/auth';
import { Botley } from '@/web/components/Botley';
import styles from './signin.module.css';

const ERRORS: Record<string, string> = {
  AccessDenied: 'Only members of our Slack workspace can sign in.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  const redirectTo = callbackUrl?.startsWith('/') ? callbackUrl : '/';
  return (
    <main className={styles.page}>
      <div className={`card ${styles.panel}`}>
        <Botley state="idle" size={120} />
        <h1>Sign in to Botley</h1>
        {error && (
          <p role="alert" className={styles.error}>
            {ERRORS[error] ?? 'Sign-in failed. Please try again.'}
          </p>
        )}
        <form
          action={async () => {
            'use server';
            await signIn('slack', { redirectTo });
          }}
        >
          <button type="submit" className="btn">
            Sign in with Slack
          </button>
        </form>
      </div>
    </main>
  );
}
