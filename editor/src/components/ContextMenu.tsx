// A small self-contained popover menu anchored at viewport coordinates, opened
// by a right-click / long-press on the staff. Items act on the current
// selection (move, delete). Closes on Escape or any pointer-down outside it.

import { useEffect } from "preact/hooks";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ReadonlyArray<ContextMenuItem>;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    // A pointer-down anywhere dismisses; the menu stops propagation on its own
    // pointer-downs (below) so selecting an item does not pre-empt its click.
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 1000,
        minWidth: 160,
        padding: 4,
        background: "#fff",
        border: "1px solid #ccc",
        borderRadius: 6,
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
        fontSize: 14,
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (!item.disabled) {
              item.onSelect();
              onClose();
            }
          }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "6px 10px",
            border: "none",
            borderRadius: 4,
            background: "transparent",
            color: item.disabled ? "#aaa" : "#333",
            cursor: item.disabled ? "default" : "pointer",
            fontSize: 14,
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
