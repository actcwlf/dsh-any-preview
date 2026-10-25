/**
 * Message dictionaries for this package.
 *
 * The Chinese dictionary is the key-set source of truth; the English one is
 * typed against it, so a missing translation is a compile error rather than a
 * silent fallback. Keys are semantic (`sqlite.notSqlite`), matching how the
 * built-in packages name theirs.
 */

/** Simplified Chinese dictionary and the key-set source of truth. */
export const zh = {
  'common.error': '无法预览：{detail}',
  'common.fileUrl': '无法生成文件地址',
  'common.name': '名称',
  'common.type': '类型',
  'common.dims': '维度',
  'common.shape': '形状',
  'common.params': '参数量',
  'common.header': '头部',
  'common.metadata': '元数据',
  'common.tensors': '张量',
  'common.version': '版本',
  'common.architecture': '架构',
  'common.pageSize': '页大小',
  'common.pages': '页数',
  'common.encoding': '编码',
  'common.table': '表',
  'common.index': '索引',
  'common.view': '视图',
  'common.trigger': '触发器',
  'count.items': '{count} 项',
  'count.units': '{count} 个',
  'tensors.count': '共 {count} 个张量，显示前 {shown} 个。',
  'metadata.count': '共 {count} 项元数据，显示前 {shown} 项。',

  'safetensors.loading': '正在读取头部…',
  'safetensors.tooShort': '文件过短，不是 SafeTensors',
  'safetensors.headerSize': '头部长度 {size} 不合理（上限 {limit}）',
  'safetensors.parseFailed': '无法解析头部',
  'safetensors.badJson': '头部不是 JSON 对象',

  'gguf.loading': '正在读取头部…',
  'gguf.parseFailed': '无法解析 GGUF 头部',
  'gguf.notGguf': '不是 GGUF 文件（缺少 GGUF 魔数）',
  'gguf.unsupportedVersion': '不支持的 GGUF 版本 {version}',
  'gguf.truncated': 'GGUF 头部在此处已超出已读取的字节，可能被截断',
  'gguf.stringTooLong': 'GGUF 字符串超出长度上限',
  'gguf.unknownType': '未知的 GGUF 值类型 {type}',
  'gguf.integerRange': 'GGUF 头部含超出安全范围的 64 位整数',

  'sqlite.loading': '正在读取结构…',
  'sqlite.noObjects': '没有可显示的 schema 对象（可能是空库）。',
  'sqlite.autoCreated': '（由 SQLite 自动创建，没有 SQL 定义）',
  'sqlite.truncated': '已读取 {pages} 页、列出 {objects} 个对象后停止；这个库的结构异常庞大。',
  'sqlite.readFailed': '无法读取结构',
  'sqlite.notSqlite': '不是 SQLite 文件（缺少文件头魔数）',
  'sqlite.badPageSize': '文件头里的页大小无效',
} as const

/** A message key. */
export type MessageKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en: Record<MessageKey, string> = {
  'common.error': 'Cannot preview: {detail}',
  'common.fileUrl': 'Cannot build a file URL',
  'common.name': 'Name',
  'common.type': 'Type',
  'common.dims': 'Dimensions',
  'common.shape': 'Shape',
  'common.params': 'Parameters',
  'common.header': 'Header',
  'common.metadata': 'Metadata',
  'common.tensors': 'Tensors',
  'common.version': 'Version',
  'common.architecture': 'Architecture',
  'common.pageSize': 'Page size',
  'common.pages': 'Pages',
  'common.encoding': 'Encoding',
  'common.table': 'Table',
  'common.index': 'Index',
  'common.view': 'View',
  'common.trigger': 'Trigger',
  'count.items': '{count} entries',
  'count.units': '{count}',
  'tensors.count': 'Showing the first {shown} of {count} tensors.',
  'metadata.count': 'Showing the first {shown} of {count} metadata entries.',

  'safetensors.loading': 'Reading header…',
  'safetensors.tooShort': 'File is too short to be SafeTensors',
  'safetensors.headerSize': 'Implausible header size {size} (limit {limit})',
  'safetensors.parseFailed': 'Cannot parse the header',
  'safetensors.badJson': 'The header is not a JSON object',

  'gguf.loading': 'Reading header…',
  'gguf.parseFailed': 'Cannot parse the GGUF header',
  'gguf.notGguf': 'Not a GGUF file (missing GGUF magic)',
  'gguf.unsupportedVersion': 'Unsupported GGUF version {version}',
  'gguf.truncated': 'The GGUF header runs past the bytes read; it may be truncated',
  'gguf.stringTooLong': 'A GGUF string exceeds the length cap',
  'gguf.unknownType': 'Unknown GGUF value type {type}',
  'gguf.integerRange': 'The GGUF header holds a 64-bit integer beyond the safe range',

  'sqlite.loading': 'Reading structure…',
  'sqlite.noObjects': 'No schema objects to show (the database may be empty).',
  'sqlite.autoCreated': '(created automatically by SQLite, no SQL definition)',
  'sqlite.truncated': 'Stopped after {pages} pages and {objects} objects; this schema is unusually large.',
  'sqlite.readFailed': 'Cannot read the schema',
  'sqlite.notSqlite': 'Not a SQLite file (missing header magic)',
  'sqlite.badPageSize': 'The header declares an invalid page size',
}
