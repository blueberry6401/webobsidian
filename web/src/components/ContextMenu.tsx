import { useEffect, useState } from 'react';
import { useStore, type ContextMenuItem } from '../lib/store';
import Icon from './Icon';

function MenuList({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="context-sep" />
        ) : (
          <div
            key={i}
            className={`context-item ${it.danger ? 'danger' : ''} ${it.submenu ? 'has-sub' : ''}`}
            onMouseEnter={() => setOpenSub(it.submenu ? i : null)}
            onClick={(e) => {
              if (it.submenu) {
                e.stopPropagation();
                return;
              }
              it.onClick?.();
              onClose();
            }}
          >
            {it.icon && <Icon name={it.icon} size={15} />}
            <span className="ctx-label">{it.label}</span>
            {it.submenu && <Icon name="chevron-right" size={14} className="ctx-arrow" />}
            {it.submenu && openSub === i && (
              <div className="context-menu submenu">
                <MenuList items={it.submenu} onClose={onClose} />
              </div>
            )}
          </div>
        ),
      )}
    </>
  );
}

export default function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const close = useStore((s) => s.closeContextMenu);

  useEffect(() => {
    if (!menu) return;
    const onClick = () => close();
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, [menu, close]);

  if (!menu) return null;
  const x = Math.min(menu.x, window.innerWidth - 240);
  const y = Math.min(menu.y, window.innerHeight - menu.items.length * 30 - 16);

  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      <MenuList items={menu.items} onClose={close} />
    </div>
  );
}
