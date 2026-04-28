'use client';
import { useState } from 'react';
import {
  Columns2, Grid3x3, LayoutGrid, Rows2, SquareStack, Sparkles,
} from 'lucide-react';
import { useTabs, type ViewMode } from '@/lib/tabs-store';
import { TileGridDialog } from './tile-grid-dialog';

interface ButtonDef { mode: ViewMode; icon: typeof Columns2; label: string; }

const BUTTONS: readonly ButtonDef[] = [
  { mode: 'tabs',      icon: LayoutGrid,   label: 'Tabs view'        },
  { mode: 'tile-h',    icon: Rows2,        label: 'Tile horizontal'  },
  { mode: 'tile-v',    icon: Columns2,     label: 'Tile vertical'    },
  { mode: 'tile-grid', icon: Grid3x3,      label: 'Tile grid…'       },
  { mode: 'cascade',   icon: SquareStack,  label: 'Cascade'          },
  { mode: 'auto',      icon: Sparkles,     label: 'Auto-arrange'     },
];

export function ViewModeToolbar() {
  const viewMode    = useTabs((s) => s.viewMode);
  const setViewMode = useTabs((s) => s.setViewMode);
  const [gridDialog, setGridDialog] = useState(false);

  function onClick(mode: ViewMode) {
    if (mode === 'tile-grid') {
      setGridDialog(true);
      return;
    }
    setViewMode(mode);
  }

  return (
    <>
      <div
        className="ml-auto flex items-stretch border-l border-border"
        role="toolbar"
        aria-label="Window view mode"
      >
        {BUTTONS.map(({ mode, icon: Icon, label }) => {
          const on = viewMode === mode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onClick(mode)}
              title={label}
              aria-label={label}
              aria-pressed={on}
              className={`relative w-8 h-full flex items-center justify-center ${
                on ? 'text-fg' : 'text-muted hover:text-fg hover:bg-surface2/40'
              } focus-ring`}
            >
              {on && <span className="absolute left-1 right-1 bottom-0 h-0.5 bg-accent" aria-hidden />}
              <Icon size={14} />
            </button>
          );
        })}
      </div>
      {gridDialog && (
        <TileGridDialog
          onCancel={() => setGridDialog(false)}
          onConfirm={(rows, cols) => {
            useTabs.getState().setTileGrid(rows, cols);
            setViewMode('tile-grid');
            setGridDialog(false);
          }}
        />
      )}
    </>
  );
}
