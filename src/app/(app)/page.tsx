import { Botley } from '@/web/components/Botley';
import { requireUser } from '@/web/current-user';
import styles from './home.module.css';

export default async function HomePage() {
  const user = await requireUser();
  const firstName = user.name.split(' ')[0];
  return (
    <section className={`card ${styles.empty}`}>
      <Botley state="idle" />
      <div>
        <h1 className={styles.title}>Hi {firstName}, I&apos;m Botley.</h1>
        <p className={styles.lead}>Nothing here yet. Soon you&apos;ll be able to ask me about your data right here, or by mentioning me in Slack.</p>
      </div>
    </section>
  );
}
