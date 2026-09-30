// 搜索框"以图搜图"图片条：上传按钮 + 已选图片缩略图（可删除）。
// 从 SearchDialog 拆出以控单文件行数；无业务逻辑，只做文件读取与展示。
import { useRef } from "react";
import { Icon } from "../../components/icons";

export const MAX_SEARCH_IMAGES = 4;

export interface SearchImageBarProps {
  images: string[];
  onAdd: (dataUrls: string[]) => void;
  onRemove: (index: number) => void;
}

/** 读文件为 dataURL（图片才收）。 */
function readImage(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/")) return resolve(null);
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(file);
  });
}

export function SearchImageBar({ images, onAdd, onRemove }: SearchImageBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const canAdd = images.length < MAX_SEARCH_IMAGES;

  async function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const slots = MAX_SEARCH_IMAGES - images.length;
    const picked: string[] = [];
    for (const f of Array.from(files).slice(0, slots)) {
      const url = await readImage(f);
      if (url) picked.push(url);
    }
    if (picked.length > 0) onAdd(picked);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="flex items-center gap-2">
      {images.map((src, i) => (
        <span key={i} className="group relative h-10 w-10 shrink-0 overflow-hidden rounded-gx-lg border border-gx-separator">
          <img src={src} alt="" className="h-full w-full object-cover" />
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="absolute right-0 top-0 hidden h-4 w-4 items-center justify-center bg-black/55 text-gx-10 text-white group-hover:flex"
            aria-label="移除图片"
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      {canAdd && (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-gx-lg border border-dashed border-gx-separator text-gx-text-tertiary hover:border-gx-accent hover:text-gx-accent"
          aria-label="上传图片以图搜图"
          title="上传图片，以图搜图"
        >
          <Icon name="image" size={16} />
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => pick(e.target.files)}
      />
    </div>
  );
}
