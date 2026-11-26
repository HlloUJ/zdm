package com.zdm.platform.common;

import java.sql.SQLException;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.validation.FieldError;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class GlobalExceptionHandler {
  private static final Logger LOGGER = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  @ExceptionHandler(FieldValidationException.class)
  public ResponseEntity<?> handleInvalidField(FieldValidationException ex) {
    var response = ResponseEntity.badRequest().header("X-Zdm-Invalid-Field", ex.field());
    if (!ex.hint().equals(ex.getMessage())) {
      return response.body(new ValidationFailure(400, ex.getMessage(), null, List.of(new InvalidField(ex.field(), ex.hint()))));
    }
    return response.body(ApiResponse.fail(ex.getMessage()));
  }

  @ExceptionHandler(OperationBlockedException.class)
  public ResponseEntity<ApiResponse<Void>> handleOperationBlocked(OperationBlockedException ex) {
    return ResponseEntity.badRequest().header("X-Zdm-Operation-Blocked", "true")
        .body(ApiResponse.fail(ex.getMessage()));
  }

  @ExceptionHandler(IllegalArgumentException.class)
  public ResponseEntity<ApiResponse<Void>> handleIllegalArgument(IllegalArgumentException ex) {
    return ResponseEntity.badRequest().body(ApiResponse.fail(ex.getMessage()));
  }

  public record InvalidField(String field, String message) {}
  public record ValidationFailure(int code, String message, Void data, List<InvalidField> fieldErrors) {}

  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<ValidationFailure> handleValidation(MethodArgumentNotValidException ex) {
    var errors = ex.getBindingResult().getFieldErrors();
    String message = errors.stream().findFirst()
        .map(error -> error.getField() + error.getDefaultMessage()).orElse("请求参数错误");
    var fields = errors.stream().map(error -> new InvalidField(error.getField(), fieldMessage(error))).toList();
    return ResponseEntity.badRequest().body(new ValidationFailure(400, message, null, fields));
  }

  private static String fieldMessage(FieldError error) {
    String detail = error.getDefaultMessage();
    if (detail != null && detail.codePoints().anyMatch(c -> Character.UnicodeScript.of(c) == Character.UnicodeScript.HAN)) {
      return detail;
    }
    return switch (String.valueOf(error.getCode())) {
      case "NotBlank", "NotNull", "NotEmpty" -> "请填写必填内容";
      case "Size", "Length" -> "请检查填写长度或所选数量";
      case "Min", "Max", "DecimalMin", "DecimalMax", "Positive", "PositiveOrZero" -> "请调整数值至允许范围内";
      default -> "请检查填写格式";
    };
  }

  // MySQL reports the violated unique index in the final, database-generated part of error 1062.
  private static final Pattern DUPLICATE_INDEX = Pattern.compile(" for key '(?:[^']+[.])?([a-zA-Z0-9_]+)'$");

  @ExceptionHandler(DuplicateKeyException.class)
  public ResponseEntity<?> handleDuplicateKey(DuplicateKeyException ex) {
    if (!(ex.getMostSpecificCause() instanceof SQLException sql) || sql.getErrorCode() != 1062 || sql.getMessage() == null) {
      return handleException(ex);
    }
    var match = DUPLICATE_INDEX.matcher(sql.getMessage());
    if (!match.find()) return handleException(ex);
    InvalidField field = switch (match.group(1)) {
      case "uk_slab_varieties_name" -> new InvalidField("name", "品种名称已存在");
      case "uk_slab_origins_name" -> new InvalidField("name", "产地名称已存在");
      case "uk_slab_textures_name" -> new InvalidField("name", "纹理名称已存在");
      case "uk_slab_texture_aliases_name" -> new InvalidField("name", "别名已存在或与标准纹理重复");
      case "uk_slab_colors_name" -> new InvalidField("name", "色系名称已存在");
      case "uk_slab_color_categories_name" -> new InvalidField("name", "色系分类名称已存在");
      case "uk_slab_grades_code" -> new InvalidField("code", "等级已存在");
      case "uk_slab_grades_name" -> new InvalidField("name", "等级名称已存在");
      case "uk_store_levels_name" -> new InvalidField("name", "级别名称已存在");
      case "uk_roles_scope_name" -> new InvalidField("name", "当前组织已存在同名角色");
      case "uk_crafts_name" -> new InvalidField("name", "工艺名称已存在");
      default -> null;
    };
    return field == null ? handleException(ex) : handleInvalidField(new FieldValidationException(field.field(), field.message(), ex));
  }

  @ExceptionHandler(AccessDeniedException.class)
  public ResponseEntity<ApiResponse<Void>> handleAccessDenied(AccessDeniedException ex) {
    return ResponseEntity.status(HttpStatus.FORBIDDEN).body(new ApiResponse<>(403, ex.getMessage(), null));
  }

  @ExceptionHandler(NoResourceFoundException.class)
  public ResponseEntity<ApiResponse<Void>> handleNotFound(NoResourceFoundException ex) {
    return ResponseEntity.status(HttpStatus.NOT_FOUND).body(new ApiResponse<>(404, "资源不存在", null));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<ApiResponse<Void>> handleException(Exception ex) {
    LOGGER.error("Unhandled API exception", ex);
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(ApiResponse.fail("系统异常"));
  }
}
