import { useEffect, useRef, useState } from 'react';
import { game, useGame } from '../state/store.ts';
import { net } from '../net/connection.ts';
import { onKeyPress } from '../game/input.ts';

export function Chat() {
  const chat = useGame((s) => s.chat);
  const focused = useGame((s) => s.chatFocused);
  const radius = useGame((s) => s.config?.chatRadius ?? 150);
  const [text, setText] = useState('');
  const [channel, setChannel] = useState<'global' | 'local'>('global');
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => onKeyPress((code, e) => {
    if ((code === 'Enter' || code === 'KeyT') && !game.get().floorPlanFor && !game.get().dialog) {
      e.preventDefault();
      if (document.pointerLockElement) document.exitPointerLock();
      input.current?.focus();
    }
  }), []);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat.length, focused]);

  const send = () => {
    const t = text.trim();
    if (t) net.chat(t, channel);
    setText('');
    input.current?.blur();
  };

  const recent = focused ? chat : chat.filter((c) => Date.now() - c.ts < 25_000).slice(-6);
  return (
    <div className={`chat ${focused ? 'focused' : ''}`}>
      <div className="chat-list" ref={list}>
        {recent.map((c) => (
          <div key={c.id} className={`chat-line ${c.channel}`}>
            {c.from ? (
              <>
                {c.channel === 'local' && <span className="chat-tag">nearby</span>}
                <b style={{ color: c.from.color }}>{c.from.name}</b> {c.text}
              </>
            ) : (
              <i>{c.text}</i>
            )}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <button
          className={`chat-channel ${channel}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setChannel(channel === 'global' ? 'local' : 'global')}
          title={channel === 'global' ? 'Everyone online' : `Players within ${radius} m`}
        >
          {channel === 'global' ? 'All' : 'Nearby'}
        </button>
        <input
          ref={input}
          value={text}
          maxLength={240}
          placeholder={focused ? 'Say something…' : 'Press Enter to chat'}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => game.set({ chatFocused: true })}
          onBlur={() => game.set({ chatFocused: false })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
            if (e.key === 'Escape') { setText(''); input.current?.blur(); }
            e.stopPropagation();
          }}
        />
      </div>
    </div>
  );
}
