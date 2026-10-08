import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Unplug, X } from 'lucide-react';
import { useMihomo } from '../state/mihomo';
import { ConnectionForm } from './ConnectionForm';
import { Toggle } from './ui';
import './kernel-switcher.css';

export function KernelSwitcher() {
  const { demo, profile, status, startDemo, disconnect, cancelConnect } = useMihomo();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const title = demo ? '演示内核' : profile ? 'Mihomo 内核' : '连接内核';

  function positionPanel() {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const bounds = trigger.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(bounds.right + 12, window.innerWidth - width - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(bounds.top, window.innerHeight - panel.offsetHeight - 12))}px`;
  }

  function closePanel(restoreFocus = false) {
    panelRef.current?.hidePopover();
    if (restoreFocus) triggerRef.current?.focus();
  }

  function openPanel() {
    panelRef.current?.showPopover();
    positionPanel();
    panelRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      )
        panelRef.current?.hidePopover();
    };
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
    document.addEventListener('focusin', onFocus);
    const observer = new ResizeObserver(positionPanel);
    if (panelRef.current) observer.observe(panelRef.current);
    if (triggerRef.current) observer.observe(triggerRef.current);
    return () => {
      window.removeEventListener('resize', positionPanel);
      window.removeEventListener('scroll', positionPanel, true);
      document.removeEventListener('focusin', onFocus);
      observer.disconnect();
    };
  }, [open]);

  return (
    <div className="kernel-switcher">
      <button
        ref={triggerRef}
        type="button"
        className="kernel-switcher-trigger"
        aria-label="切换内核"
        aria-describedby={`${panelId}-current`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        popoverTarget={panelId}
        onKeyDown={(event) => {
          if (['ArrowRight', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            openPanel();
          }
          if (event.key === 'Escape') closePanel(true);
        }}
      >
        <img src="./favicon.svg" width="39" height="39" alt="" />
        <span className="kernel-switcher-brand">
          <strong>
            mihomo<span>verge</span>
          </strong>
          <small id={`${panelId}-current`}>
            <i className={`kernel-status-dot ${status}`} aria-hidden="true" />
            {title}
            <ChevronRight className="kernel-switcher-chevron" size={13} />
          </small>
        </span>
      </button>
      <div
        ref={panelRef}
        id={panelId}
        className="kernel-switcher-panel"
        popover="auto"
        role="dialog"
        aria-labelledby={`${panelId}-title`}
        onBeforeToggle={(event) => {
          if (event.newState === 'open') positionPanel();
          else cancelConnect();
        }}
        onToggle={(event) => {
          const isOpen = event.newState === 'open';
          setOpen(isOpen);
          if (isOpen) positionPanel();
          if (
            !isOpen &&
            (document.activeElement === document.body ||
              panelRef.current?.contains(document.activeElement))
          )
            triggerRef.current?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closePanel(true);
          }
        }}
      >
        <div className="kernel-switcher-heading">
          <h2 id={`${panelId}-title`}>连接到 Mihomo</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={() => closePanel(true)}
          >
            <X size={17} />
          </button>
        </div>
        {open && <ConnectionForm compact onClose={() => closePanel(true)} />}
        <div className="kernel-switcher-session">
          <span>演示模式</span>
          <Toggle
            label="演示模式"
            checked={demo}
            onChange={(enabled) => {
              if (enabled) startDemo();
              else disconnect();
            }}
          />
        </div>
        {!demo && profile && (
          <button
            type="button"
            className="button small kernel-switcher-disconnect"
            onClick={() => {
              disconnect();
              closePanel(true);
            }}
          >
            <Unplug size={14} />
            断开连接
          </button>
        )}
      </div>
    </div>
  );
}
