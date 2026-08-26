<template><canvas ref="canvas" class="pet-canvas"></canvas></template>
<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AmbientLight, CanvasTexture, Clock, ColorManagement, NearestFilter, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { IdleAnimation, PlayerObject, WalkingAnimation } from 'skinview3d';
import defaultSkin from '../assets/skins/07-lanyi.png';
const props = defineProps({ texture:{type:String,default:''}, model:{type:String,default:'slim'}, animation:{type:String,default:'idle'}, facing:{type:String,default:'right'} });
const canvas=ref(null); let renderer,player,texture,frame,activeAnimation; const clock=new Clock();
function setAnimation(){
  player?.resetJoints();
  activeAnimation=props.animation==='walk'?new WalkingAnimation():new IdleAnimation();
  activeAnimation.speed=props.animation==='walk'?1.35:1;
  if(props.animation!=='walk') activeAnimation.addAnimation((target,time)=>{
    target.skin.head.rotation.y=Math.sin(time*.9)*.14;
    target.skin.leftArm.rotation.x=Math.sin(time*1.7)*.09;
    target.skin.rightArm.rotation.x=-Math.sin(time*1.7)*.09;
    target.position.y=Math.sin(time*2.1)*.16;
  });
}
function setFacing(){ if(player) player.rotation.y=props.facing==='left'?-0.32:0.32; }
function loadSkin(){ if(!player)return; const image=new Image(); image.crossOrigin='anonymous'; image.onload=()=>{ texture?.dispose(); texture=new CanvasTexture(image); texture.magFilter=NearestFilter; texture.minFilter=NearestFilter; texture.needsUpdate=true; player.skin.map=texture; player.skin.modelType=props.model==='slim'?'slim':'default'; player.skin.visible=true; }; image.onerror=()=>{if(image.src!==defaultSkin)image.src=defaultSkin;}; image.src=props.texture||defaultSkin; }
onMounted(()=>{ ColorManagement.enabled=false; const scene=new Scene(); const camera=new PerspectiveCamera(38,.5,1,1000); camera.position.set(0,0,58); renderer=new WebGLRenderer({canvas:canvas.value,alpha:true,antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true}); renderer.setClearColor(0,0); renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setSize(160,320,false); scene.add(new AmbientLight(0xffffff,3)); player=new PlayerObject(); player.position.y=-2; scene.add(player); setFacing(); setAnimation(); loadSkin(); window.__desktopPetDebug=()=>({animation:props.animation,textureLoaded:Boolean(player.skin.map),textureSize:[texture?.image?.width||0,texture?.image?.height||0],alpha:renderer.getContext().getContextAttributes()?.alpha,render:{...renderer.info.render},headY:player.skin.head.rotation.y,leftArmX:player.skin.leftArm.rotation.x,rightLegX:player.skin.rightLeg.rotation.x}); const draw=()=>{activeAnimation?.update(player,Math.min(clock.getDelta(),.05));renderer.render(scene,camera);frame=requestAnimationFrame(draw);};draw(); });
watch(()=>props.texture,loadSkin); watch(()=>props.model,loadSkin); watch(()=>props.animation,setAnimation); watch(()=>props.facing,setFacing);
onBeforeUnmount(()=>{cancelAnimationFrame(frame);delete window.__desktopPetDebug;texture?.dispose();renderer?.dispose();});
</script>
<style scoped>.pet-canvas{display:block;width:160px;height:320px;pointer-events:none;filter:drop-shadow(0 6px 3px rgba(0,0,0,.3));}</style>
