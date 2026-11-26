const wanted = name => /\.(osu|osz|osb)$/i.test(name);

async function readEntry(entry, directory, output) {
  if (entry.isFile) {
    if (wanted(entry.name)) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      output.push({ file, directory });
    }
    return;
  }
  if (!entry.isDirectory) return;
  const path = directory ? directory + '/' + entry.name : entry.name;
  const reader = entry.createReader();
  for (;;) {
    const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!children.length) return;
    for (const child of children) await readEntry(child, path, output);
  }
}

export function fileRecords(files) {
  return Array.from(files, file => ({
    file, directory: (file.webkitRelativePath || '').split('/').slice(0, -1).join('/'),
  }));
}

// 浏览器只在 drop 事件同步处理期间开放拖入的目录句柄。
export async function droppedRecords(transfer) {
  const fallback = fileRecords(transfer.files);
  const handles = Array.from(transfer.items || []).filter(item => item.kind === 'file').map(item => ({
    entry: item.webkitGetAsEntry?.(), file: item.getAsFile(),
  }));
  if (!handles.some(item => item.entry)) return fallback;
  const output = [];
  for (const { entry, file } of handles) {
    if (entry) await readEntry(entry, '', output);
    else if (file) output.push(...fileRecords([file]));
  }
  return output;
}
