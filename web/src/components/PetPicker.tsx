import type { ReactNode } from "react";
import { t } from "../../../shared/i18n.ts";
import { isHexColor, isPetColorId, PET_COLOR_IDS, PET_COLORS, PET_SHAPE_IDS, PET_SHAPES, petSpriteId, resolvePet, type PetColorId } from "../../../shared/pet.ts";
import { Avatar } from "../sprites.tsx";

const quickColors: PetColorId[] = ["blue", "teal", "amber", "pink", "purple"];

export function PetPicker({ sprite, onChange, expanded = true, toggle }: {
  sprite: string;
  onChange: (sprite: string, customColor?: boolean) => void;
  expanded?: boolean;
  toggle?: ReactNode;
}) {
  const current = resolvePet(sprite);
  const swatches: readonly PetColorId[] = expanded
    ? PET_COLOR_IDS
    : isPetColorId(current.color) && !quickColors.includes(current.color)
      ? [current.color, ...quickColors.slice(0, 4)]
      : quickColors;
  return <>
    {expanded && <div className="sprite-pick pet-grid" role="group" aria-label={t("头像造型")}>
      {PET_SHAPE_IDS.map(shape => (
        <button key={shape} type="button" className={shape === current.shape ? "on" : undefined}
          aria-label={t(PET_SHAPES[shape].label)} aria-pressed={shape === current.shape}
          title={`${t(PET_SHAPES[shape].label)} · ${t(PET_SHAPES[shape].hint)}`}
          onClick={() => onChange(petSpriteId(shape, current.color))}>
          <Avatar sprite={petSpriteId(shape, current.color)} size={34} />
        </button>
      ))}
    </div>}
    <div className="sprite-colors pet-swatches" role="group" aria-label={t("头像颜色")}>
      {swatches.map(color => (
        <button key={color} type="button" className={color === current.color ? "on" : undefined}
          aria-label={t(PET_COLORS[color].name)} aria-pressed={color === current.color} title={t(PET_COLORS[color].name)}
          style={{ background: PET_COLORS[color].body }} onClick={() => onChange(petSpriteId(current.shape, color))} />
      ))}
      {expanded && <label className={`pet-color-custom${isHexColor(current.color) ? " on" : ""}`} title={t("自定义颜色")}>
        <input type="color" aria-label={t("自定义颜色")} value={current.body}
          onChange={event => onChange(petSpriteId(current.shape, event.target.value), true)} />
      </label>}
      {toggle}
    </div>
  </>;
}
