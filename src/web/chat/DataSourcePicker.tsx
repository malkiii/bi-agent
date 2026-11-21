import styles from './chat.module.css';

export interface DataSourceOption {
  id: string;
  name: string;
}

/**
 * Locks the Conversation to chosen Data Sources. Nothing ticked means "all": the agent
 * chooses. The choice is sent with the next Prompt and kept with the Conversation.
 */
export function DataSourcePicker({
  options,
  selected,
  onChange,
  disabled,
}: {
  options: DataSourceOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const names = options.filter((o) => selected.includes(o.id)).map((o) => o.name);
  const summary = names.length === 0 ? 'All Data Sources' : names.join(', ');
  return (
    <details className={styles.dataSourcePicker}>
      <summary>
        <span className={styles.muted}>Data Sources:</span> {summary}
      </summary>
      <fieldset disabled={disabled}>
        <legend className={styles.srOnly}>Data Sources this Conversation uses</legend>
        {options.map((o) => (
          <label key={o.id}>
            <input
              type="checkbox"
              checked={selected.includes(o.id)}
              onChange={(e) => onChange(e.target.checked ? [...selected, o.id] : selected.filter((id) => id !== o.id))}
            />
            {o.name}
          </label>
        ))}
        <p className={styles.muted}>Tick some to keep Botley to them. Leave all unticked to let it choose.</p>
      </fieldset>
    </details>
  );
}
