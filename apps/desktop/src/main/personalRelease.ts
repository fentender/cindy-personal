import { personalReleaseSource } from '@cindy/maker-shared/personal-release';

/** 发布脚本经 Vite 固化；运行中的云端端点清单无权改写发行源。 */
export function getPersonalReleaseSource() {
  return personalReleaseSource(process.env.CINDY_PERSONAL_RELEASE_REPOSITORY);
}
