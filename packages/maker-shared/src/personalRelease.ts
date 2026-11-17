export interface PersonalReleaseSource {
  repository: string;
  manifestBaseUrl: string;
  cacheDirectory: string;
}

/** 编译时选择的个人发行源，只承担安装包更新，不替换业务服务端点。 */
export function personalReleaseSource(value: string | undefined): PersonalReleaseSource | null {
  const repository = value?.trim();
  if (!repository) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(repository)) {
    throw new Error('Personal release repository must be owner/repository');
  }
  return {
    repository,
    manifestBaseUrl: `https://github.com/${repository}/releases/latest/download`,
    cacheDirectory: `updates-personal/${encodeURIComponent(repository.toLowerCase())}`,
  };
}

/** 清单可以追踪 latest，安装资产必须固定到同仓库的具体 tag。 */
export function personalReleaseAssetUrl(source: PersonalReleaseSource, value: string): string {
  const url = new URL(value);
  const prefix = `/${source.repository}/releases/download/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password
    || !url.pathname.startsWith(prefix) || !/^[^/]+\/[^/]+$/.test(url.pathname.slice(prefix.length))) {
    throw new Error('Personal update asset must use a versioned release in the configured repository');
  }
  return url.href;
}
