package com.zdm.platform.inventory;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface SlabGradeMapper extends BaseMapper<SlabGrade> {
  @Select("SELECT COUNT(*) FROM slab_inventory WHERE grade_id = #{id}")
  long countInventoryReferences(Long id);
}
