export const accessProfiles=['editor','author','designer','viewer'];
export function permissions(user){
  const admin=user?.role==='admin',profile=user?.access_profile||(user?'editor':'viewer');
  return {contentRead:Boolean(user),contentEdit:admin||['editor','author','designer'].includes(profile),contentPublish:admin||profile==='editor',mediaManage:admin||profile!=='viewer',designEdit:admin||profile==='designer'||Boolean(user?.design_access),designPublish:admin,admin};
}
