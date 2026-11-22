import { signIn } from '@/auth';
import { BIBot } from '@/web/components/BIBot';
import { PendingButton } from '@/web/components/PendingButton';
import styles from './signin.module.css';

const ERRORS: Record<string, string> = {
  AccessDenied: 'Only members of our Slack workspace can sign in.',
};

const FEATURES = [
  { title: 'Ask in plain words', text: 'Here or in Slack. BIBot writes the query and draws the chart.' },
  { title: 'Scheduled Reports', text: 'Send fresh numbers to a channel on a schedule.' },
  { title: 'KPI alerts', text: 'Hear about it when a metric crosses its line.' },
];

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  const redirectTo = callbackUrl?.startsWith('/') ? callbackUrl : '/';
  return (
    <main className={styles.page}>
      <span className={`${styles.shape} ${styles.shapeA}`} aria-hidden="true" />
      <span className={`${styles.shape} ${styles.shapeB}`} aria-hidden="true" />
      <span className={`${styles.shape} ${styles.shapeC}`} aria-hidden="true" />

      <div className={styles.layout}>
        <section className={styles.intro}>
          <div className={styles.mascot}>
            <BIBot rest={error ? 'error' : 'idle'} size={140} />
          </div>
          <h2 className={styles.tagline}>Ask your business data anything.</h2>
          <ul className={styles.features}>
            {FEATURES.map((f, i) => (
              <li key={f.title} style={{ animationDelay: `${120 + i * 80}ms` }}>
                <strong>{f.title}</strong>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={`card ${styles.panel}`}>
          <span className={styles.brand}>BIBot</span>
          <h1 className={styles.title}>Sign in</h1>
          <p className={styles.lead}>Use your Slack workspace account.</p>
          {error && (
            <p role="alert" className={styles.error}>
              {ERRORS[error] ?? 'Sign-in failed. Please try again.'}
            </p>
          )}
          <form
            className={styles.form}
            action={async () => {
              'use server';
              await signIn('slack', { redirectTo });
            }}
          >
            <PendingButton className={`btn ${styles.signIn}`}>Sign in with Slack</PendingButton>
          </form>
        </section>
      </div>
    </main>
  );
}
