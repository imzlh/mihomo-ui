import { useState } from 'react';
import { Network } from 'lucide-react';
import { safeProxyIcon } from '../lib/proxy-preferences';

export function GroupIcon({ icon }: { icon: string | undefined }) {
  const source = safeProxyIcon(icon);
  const [failed, setFailed] = useState<string | undefined>();
  return (
    <span className="proxy-group-icon" aria-hidden="true">
      {source && source !== failed ? (
        <img
          src={source}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(source)}
        />
      ) : (
        <Network size={19} />
      )}
    </span>
  );
}
