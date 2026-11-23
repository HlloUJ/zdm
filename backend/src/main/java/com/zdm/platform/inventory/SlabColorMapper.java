package com.zdm.platform.inventory;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface SlabColorMapper extends BaseMapper<SlabColor> {
  @Select("SELECT COUNT(*) FROM slab_inventory WHERE color_id = #{id}")
  long countInventoryReferences(Long id);
}
