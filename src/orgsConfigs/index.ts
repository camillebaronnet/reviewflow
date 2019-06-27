import { Config as ConfigType } from './types';
import ornikar from './ornikar';
import christophehurpeau from './christophehurpeau';

export type Config<
  GroupNames extends string = any,
  TeamNames extends string = any
> = ConfigType<GroupNames, TeamNames>;

export const orgsConfigs: { [owner: string]: Config } = {
  ornikar,
  christophehurpeau,
};

// flat requires node 11
// export const getMembers = <GroupNames extends string = any>(
//   groups: Record<GroupNames, Group>,
// ): string[] => {
//   return Object.values(groups).flat(1);
// };