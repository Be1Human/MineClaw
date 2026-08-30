export const MATERIAL_RENDER_LAYER = Object.freeze({
  OPAQUE: 'opaque',
  CUTOUT: 'cutout',
  TRANSLUCENT: 'translucent',
});

const TRANSLUCENT_TEXTURE = /(?:glass|water|lava|ice|portal|slime|honey)/i;
const CUTOUT_EXCEPTIONS = /^grass_block_side_overlay/i;
const OPAQUE_EXCEPTIONS = /^(?:grass_block|mushroom_(?:block|stem)|(?:brown|red)_mushroom_block|dried_kelp_block)/i;
const CUTOUT_TEXTURE = /(?:leaves|cobweb|web|grass|fern|sapling|dandelion|poppy|orchid|allium|bluet|tulip|daisy|cornflower|lily_of_the_valley|lily_pad|wither_rose|eyeblossom|pink_petals|wildflowers|flower|sunflower|lilac|rose_bush|peony|wheat_stage|carrots_stage|potatoes_stage|beetroots_stage|nether_wart_stage|pitcher_crop|torchflower_crop|melon_stem|pumpkin_stem|cocoa_stage|sweet_berry_bush|bush|azalea_plant|vine|seagrass|kelp|roots|sprouts|sugar_cane|bamboo|dripleaf|lichen|mushroom(?:_\d+)?$|rail|torch|fire|ladder|chain|candle|iron_bars|pane_top|door_|trapdoor|tripwire|redstone_dust)/i;

export function classifyMaterialRenderLayer(materialKey) {
  const textureName = textureBasename(materialKey);
  if (TRANSLUCENT_TEXTURE.test(textureName)) return MATERIAL_RENDER_LAYER.TRANSLUCENT;
  if (CUTOUT_EXCEPTIONS.test(textureName)) return MATERIAL_RENDER_LAYER.CUTOUT;
  if (OPAQUE_EXCEPTIONS.test(textureName)) return MATERIAL_RENDER_LAYER.OPAQUE;
  if (CUTOUT_TEXTURE.test(textureName)) return MATERIAL_RENDER_LAYER.CUTOUT;
  return MATERIAL_RENDER_LAYER.OPAQUE;
}

export function materialRenderOptions(layer) {
  if (layer === MATERIAL_RENDER_LAYER.TRANSLUCENT) {
    return { transparent: true, opacity: 0.82, alphaTest: 0, depthWrite: false, doubleSided: true };
  }
  if (layer === MATERIAL_RENDER_LAYER.CUTOUT) {
    return { transparent: false, opacity: 1, alphaTest: 0.1, depthWrite: true, doubleSided: false };
  }
  return { transparent: false, opacity: 1, alphaTest: 0, depthWrite: true, doubleSided: false };
}

export function isNonOpaqueMaterial(materialKey) {
  return classifyMaterialRenderLayer(materialKey) !== MATERIAL_RENDER_LAYER.OPAQUE;
}

function textureBasename(materialKey) {
  return String(materialKey ?? '').replace(/^.*[/:]/, '').replace(/\.png$/i, '');
}
