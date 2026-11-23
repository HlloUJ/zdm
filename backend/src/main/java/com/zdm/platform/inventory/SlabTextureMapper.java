package com.zdm.platform.inventory;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface SlabTextureMapper extends BaseMapper<SlabTexture> {
  @Select("SELECT COUNT(*) FROM slab_inventory WHERE texture_id = #{id}")
  long countInventoryReferences(Long id);
}
