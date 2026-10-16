/** Locale-owned inspection copy; wire data remains verbatim. */
export const en = {
  panel: 'Trajectories', intro: 'Follow agent runs, inspect scope decisions, and read the original records.',
  live: 'Live follow', paused: 'Paused', refresh: 'Refresh', loading: 'Loading trajectories…', empty: 'No traces match these filters.',
  unavailable: 'Collector unavailable. Check the collector and trace-projection plugins, then refresh.',
  stale: 'Connection interrupted. The last received page is shown.', select: 'Select a trace to inspect its execution.',
  search: 'Search traces', installation: 'Installation', student: 'Student', cohort: 'Cohort', session: 'Session',
  all: 'All', running: 'Running', completed: 'Completed', error: 'Error', blocked: 'Blocked', status: 'Status',
  next: 'Next page', first: 'First page', tree: 'Execution tree', timeline: 'Timeline', raw: 'Original records',
  more: 'This page is bounded. Use Next page to continue.', parent: 'Parent session', children: 'Child sessions',
  source: 'Inspect source records', rawSearch: 'Search this record page', noRaw: 'No records on this page.',
  turn: 'Turn {turn}', duration: '{value} ms', records: '{count} records', traces: '{count} traces', spans: '{count} spans',
  lag: 'Indexed {indexed} / {source} records', retained: 'Full source is kept in the collector; the viewer never truncates a record.',
  close: 'Close source records', pageSearch: 'Matches on this page only', name: 'Step', kind: 'Kind',
  sourceCursor: 'Source cursor {cursor}', scope: 'Scope decision', expand: 'Expand step', collapse: 'Collapse step',
  indexing: 'Indexing', idle: 'Up to date', failed: 'Index failed', stopped: 'Stopped',
  incomplete: 'Incomplete', noTrace: 'This trace is not available.', apply: 'Apply filters',
  traceLabel: '{name} · {status} · {student}',
} as const
/** Keys resolved by the standard locale seat. */
export type LocaleKey = keyof typeof en
/** Complete Chinese dictionary with the same format parameters. */
export const zh: Record<LocaleKey, string> = {
  panel: '轨迹', intro: '跟踪智能体运行、检查范围判断并读取原始记录。',
  live: '实时跟踪', paused: '已暂停', refresh: '刷新', loading: '正在加载轨迹…', empty: '没有符合筛选条件的轨迹。',
  unavailable: '采集器不可用。请检查采集器和轨迹投影插件，然后刷新。', stale: '连接中断。当前显示最后收到的页面。', select: '选择一条轨迹以检查其执行过程。',
  search: '搜索轨迹', installation: '安装实例', student: '学员', cohort: '班级', session: '会话',
  all: '全部', running: '运行中', completed: '已完成', error: '错误', blocked: '已阻止', status: '状态',
  next: '下一页', first: '第一页', tree: '执行树', timeline: '时间线', raw: '原始记录', more: '此页面有大小限制。使用“下一页”继续。',
  parent: '父会话', children: '子会话', source: '检查源记录', rawSearch: '搜索此记录页面', noRaw: '此页面没有记录。',
  turn: '轮次 {turn}', duration: '{value} 毫秒', records: '{count} 条记录', traces: '{count} 条轨迹', spans: '{count} 个步骤',
  lag: '已索引 {indexed} / {source} 条记录', retained: '采集器保留完整源数据；查看器不会截断记录。',
  close: '关闭源记录', pageSearch: '仅匹配当前页面', name: '步骤', kind: '类型', sourceCursor: '源游标 {cursor}',
  scope: '范围判断', expand: '展开步骤', collapse: '折叠步骤', indexing: '正在索引', idle: '已同步', failed: '索引失败', stopped: '已停止',
  incomplete: '不完整', noTrace: '此轨迹不可用。', apply: '应用筛选',
  traceLabel: '{name} · {status} · {student}',
}
