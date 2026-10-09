// Modules define content types. UI and API consume the same registry.
export const modules = Object.freeze([
  { key: 'pages', label: 'صفحات', singular: 'صفحه', prefix: '', required: true },
  { key: 'services', label: 'خدمات', singular: 'خدمت', prefix: 'services', required: false },
  { key: 'posts', label: 'مقالات', singular: 'مقاله', prefix: 'articles', required: false },
  { key: 'portfolio', label: 'نمونه‌کار', singular: 'نمونه‌کار', prefix: 'work', required: false },
]);
export const moduleByKey = key => modules.find(module => module.key === key);
export function contentPath(item) {
  const module = moduleByKey(item.kind);
  if (!module) throw new Error('Unknown module');
  return item.kind === 'pages' && item.slug === 'home' ? '/' : `/${module.prefix ? `${module.prefix}/` : ''}${item.slug}/`;
}
