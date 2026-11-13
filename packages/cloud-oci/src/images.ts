import { DeployError } from './errors.js';
import type { ImageRecord } from './gateway.js';

/** Platform Ubuntu on A1 only. Marketplace, Windows, and billable images are refused. */
export class OciImageSelector {
  static select(images: readonly ImageRecord[]): ImageRecord {
    const eligible = images.filter(image => this.freeUbuntu(image));
    if (eligible.length === 0) throw new DeployError('IMAGE_NOT_FREE');
    eligible.sort((left, right) => {
      if (left.operatingSystemVersion !== right.operatingSystemVersion) {
        return left.operatingSystemVersion < right.operatingSystemVersion ? 1 : -1;
      }
      return Date.parse(right.timeCreated) - Date.parse(left.timeCreated);
    });
    const chosen = eligible[0];
    if (!chosen) throw new DeployError('IMAGE_NOT_FREE');
    return chosen;
  }

  private static freeUbuntu(image: ImageRecord): boolean {
    if (image.lifecycleState !== 'AVAILABLE') return false;
    if (image.operatingSystem !== 'Canonical Ubuntu') return false;
    if (image.operatingSystemVersion !== '24.04' && image.operatingSystemVersion !== '22.04') return false;
    if (!image.displayName.includes('aarch64')) return false;
    if (image.listingType !== undefined && image.listingType !== 'NONE') return false;
    if (image.billableSizeInGBs !== undefined && image.billableSizeInGBs > 0) return false;
    return true;
  }
}
