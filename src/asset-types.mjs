export const mediaExtensions=Object.freeze({'image/png':'png','image/jpeg':'jpg','model/gltf-binary':'glb','font/woff':'woff'});
export const isImage=item=>['image/png','image/jpeg'].includes(item.mime);
export const extension=item=>mediaExtensions[item.mime];
export const assetLimit=mime=>mime==='model/gltf-binary'?20*1024*1024:mime==='font/woff'?2*1024*1024:5*1024*1024;
