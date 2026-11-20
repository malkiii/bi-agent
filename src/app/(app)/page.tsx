import { BotleyCue } from '@/web/botley/BotleyProvider';
import { Botley } from '@/web/components/Botley';
import { requireUser } from '@/web/current-user';
import styles from './home.module.css';

/** Botley celebrates if the user arrived here straight from signing in. */
const JUST_SIGNED_IN_MS = 15_000;

function signedInWithin(lastSignInAt: Date, ms: number, now: Date) {
  return now.getTime() - lastSignInAt.getTime() < ms;
}

export default async function HomePage() {
  const user = await requireUser();
  const firstName = user.name.split(' ')[0];
  return (
    <section className={`card ${styles.empty}`}>
      {signedInWithin(user.lastSignInAt, JUST_SIGNED_IN_MS, new Date()) && <BotleyCue state="success" />}
      <Botley />
      <div>
        <h1 className={styles.title}>Hi {firstName}, I&apos;m Botley.</h1>
        <p className={styles.lead}>Nothing here yet. Soon you&apos;ll be able to ask me about your data right here, or by mentioning me in Slack.</p>
      </div>
    </section>
  );
}
